import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pic_order_desktop/features/orders/data/local_order_repository.dart';
import 'package:pic_order_desktop/features/orders/domain/order_image.dart';
import 'package:pic_order_desktop/features/orders/domain/order_document.dart';

void main() {
  late Directory root;
  late LocalOrderRepository repository;
  final bytes = base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  );

  setUp(() async {
    root = await Directory.systemTemp.createTemp('pic-order-test-');
    repository = LocalOrderRepository(Directory('${root.path}/library'));
  });
  tearDown(() async => root.delete(recursive: true));

  test('原文件独立复制且字节不变，重开保留多模板关联', () async {
    final source = await File('${root.path}/客户原图.png').writeAsBytes(bytes);
    final order = await repository.create('001610');
    final imported = await repository.importImage(
      order,
      source.path,
      ImageSource.localFile,
    );
    final saved = imported.assignTemplates(imported.images.single.id, {
      'A08',
      'A03',
    });
    await repository.save(saved);
    await source.delete();
    final reopened = await LocalOrderRepository(repository.root).load(order.id);
    expect(reopened.orderNumber, '001610');
    expect(
      reopened.images.single.templateIds,
      unorderedEquals(['缤纷糖果.png', '模板混合.png']),
    );
    expect(
      await File(
        repository.imagePath(reopened.id, reopened.images.single),
      ).readAsBytes(),
      bytes,
    );
    expect(reopened.images.single.originalName, '客户原图.png');
    expect(reopened.images.single.originalVerified, isFalse);
    expect(await repository.listOrders(), hasLength(1));
  });

  test('同订单号重新录入打开已有订单，不产生第二份', () async {
    final first = await repository.create('610');
    final second = await repository.create(' 610 ');
    expect(second.id, first.id);
    expect(await repository.listOrders(), hasLength(1));
  });

  test('新单首次保存失败不阻断已有订单和后续录单', () async {
    final existing = await repository.create('610');
    final invalid =
        OrderDocument.create(
          id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          orderNumber: 'bad',
        ).addImage(
          OrderImage(
            id: 'bad',
            originalName: 'a.png',
            storedName: '../a.png',
            byteLength: 1,
            source: ImageSource.localFile,
          ),
        );
    await expectLater(
      repository.save(invalid),
      throwsA(isA<FormatException>()),
    );
    expect((await repository.listOrders()).single.id, existing.id);
    expect((await repository.create('611')).orderNumber, '611');
  });

  test('中断的新单暂存目录不进入正式订单列表', () async {
    final existing = await repository.create('610');
    final interrupted = Directory(
      '${repository.root.path}/pending/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    );
    await interrupted.create(recursive: true);
    await File(
      '${interrupted.path}/order.json.tmp',
    ).writeAsString('{interrupted');
    expect((await repository.listOrders()).single.id, existing.id);
    expect((await repository.create('611')).orderNumber, '611');
  });

  test('损坏快照从备份恢复，两份损坏明确报错', () async {
    final order = await repository.create('610');
    await repository.save(order);
    final snapshot = File(
      '${repository.root.path}/orders/${order.id}/order.json',
    );
    await snapshot.writeAsString('{broken');
    expect((await repository.load(order.id)).orderNumber, '610');
    await File('${snapshot.path}.bak').writeAsString('{also broken');
    await expectLater(
      repository.load(order.id),
      throwsA(isA<FormatException>()),
    );
    await expectLater(repository.listOrders(), throwsA(isA<FormatException>()));
  });

  test('损坏主快照后保存仍保留可读快照', () async {
    final order = await repository.create('610');
    await repository.save(order);
    final snapshot = File(
      '${repository.root.path}/orders/${order.id}/order.json',
    );
    await snapshot.writeAsString('{broken');
    final recovered = await repository.load(order.id);
    await repository.save(recovered);
    expect((await repository.load(order.id)).orderNumber, '610');
  });

  test('拒绝非图片，且不把它追加到订单', () async {
    final source = await File(
      '${root.path}/fake.png',
    ).writeAsString('not an image');
    final order = await repository.create('610');
    await expectLater(
      repository.importImage(order, source.path, ImageSource.desktopDrop),
      throwsA(isA<FormatException>()),
    );
    expect((await repository.load(order.id)).images, isEmpty);
  });

  test('拒绝越界目录与快照中的图片路径', () async {
    await expectLater(repository.load('../outside'), throwsArgumentError);
    final order = await repository.create('610');
    final snapshot = File(
      '${repository.root.path}/orders/${order.id}/order.json',
    );
    final json =
        jsonDecode(await snapshot.readAsString()) as Map<String, dynamic>;
    json['images'] = [
      {
        'id': 'photo',
        'originalName': 'a.png',
        'storedName': '../../a.png',
        'byteLength': 1,
        'source': 'localFile',
        'originalVerified': false,
        'templateIds': <String>[],
      },
    ];
    await snapshot.writeAsString(jsonEncode(json));
    await expectLater(
      repository.load(order.id),
      throwsA(isA<FormatException>()),
    );
  });
}
