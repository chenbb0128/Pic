import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pic_order_desktop/features/orders/application/order_controller.dart';
import 'package:pic_order_desktop/features/orders/data/local_order_repository.dart';
import 'package:pic_order_desktop/features/orders/domain/order_document.dart';
import 'package:pic_order_desktop/features/orders/domain/order_image.dart';
import 'package:pic_order_desktop/features/templates/template_definition.dart';

class FailingSaveRepository extends LocalOrderRepository {
  FailingSaveRepository(super.root);
  bool failWrites = false;
  Completer<void>? gate;

  @override
  Future<void> save(OrderDocument order) async {
    if (gate != null) await gate!.future;
    if (failWrites) throw const FileSystemException('disk full');
    await super.save(order);
  }
}

void main() {
  late Directory temporary;
  late FailingSaveRepository repository;
  late OrderController controller;

  setUp(() async {
    temporary = await Directory.systemTemp.createTemp('pic-controller-');
    repository = FailingSaveRepository(Directory('${temporary.path}/library'));
    controller = OrderController(
      repository: repository,
      templates: initialTemplates,
    );
    await controller.initialize();
    await controller.openOrCreate('610');
    final image = await File('${temporary.path}/a.png').writeAsBytes(
      base64Decode(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      ),
    );
    await controller.importPaths([image.path], ImageSource.localFile);
  });
  tearDown(() async {
    controller.dispose();
    await temporary.delete(recursive: true);
  });

  test('保存失败保留原关联并显示错误，重试成功后才更新', () async {
    repository.failWrites = true;
    expect(await controller.setTemplate('A03', true), isFalse);
    expect(controller.selectedImage!.templateIds, isEmpty);
    expect(controller.error, contains('disk full'));
    repository.failWrites = false;
    expect(await controller.setTemplate('A03', true), isTrue);
    expect(controller.selectedImage!.templateIds, {'模板混合.png'});
    expect(controller.error, isNull);
  });

  test('写入中拒绝切单，避免把当前图片分配到另一订单', () async {
    repository.gate = Completer<void>();
    final saving = controller.setTemplate('A03', true);
    expect(controller.busy, isTrue);
    expect(await controller.openOrCreate('other'), isFalse);
    expect(controller.current!.orderNumber, '610');
    repository.gate!.complete();
    await saving;
    expect((await repository.listOrders()), hasLength(1));
  });

  test('没有订单时拖入图片明确拒绝，不丢入其他订单', () async {
    final empty = OrderController(
      repository: repository,
      templates: initialTemplates,
    );
    addTearDown(empty.dispose);
    expect(
      await empty.importPaths(['anything.png'], ImageSource.desktopDrop),
      isFalse,
    );
    expect(empty.error, contains('订单'));
  });

  test('同图同模板可设置多份，重开保留份数且切换其他模板不重置', () async {
    final image = controller.selectedImage!;
    final path = controller.imagePath(image);
    expect(await controller.setTemplateQuantity('A03', 3), isTrue);
    expect(await controller.setTemplate('A08', true), isTrue);
    expect(controller.current!.taskCount, 4);
    expect(controller.selectedImage!.templateQuantities, {
      '模板混合.png': 3,
      '缤纷糖果.png': 1,
    });
    expect(await controller.setTemplate('A08', false), isTrue);
    expect(controller.current!.taskCount, 3);
    expect(await controller.setTemplate('A03', true), isTrue);
    await controller.openOrder(controller.current!.id);
    expect(controller.selectedImage!.templateQuantities, {'模板混合.png': 3});
    expect(controller.current!.images, hasLength(1));
    expect(controller.imagePath(controller.selectedImage!), path);
    await controller.importPaths([path], ImageSource.localFile);
    expect(controller.selectedImage!.templateIds, isEmpty);
    controller.selectImage(image.id);
    expect(await controller.setTemplateQuantity('A03', 0), isTrue);
    expect(controller.current!.taskCount, 0);
    expect(controller.current!.unassignedCount, 2);
    expect(
      (await repository.load(controller.current!.id)).images.first.templateIds,
      isEmpty,
    );
  });

  test('份数保存失败或数量无效时保留原份数，可重试', () async {
    await controller.setTemplateQuantity('A03', 2);
    repository.failWrites = true;
    expect(await controller.setTemplateQuantity('A03', 3), isFalse);
    expect(controller.current!.taskCount, 2);
    expect((await repository.load(controller.current!.id)).taskCount, 2);
    repository.failWrites = false;
    expect(await controller.setTemplateQuantity('A03', -1), isFalse);
    expect(controller.current!.taskCount, 2);
    expect(await controller.setTemplateQuantity('missing', 2), isFalse);
    expect(controller.current!.taskCount, 2);
    expect(await controller.setTemplateQuantity('A03', 3), isTrue);
    expect(controller.current!.taskCount, 3);
  });

  test('删除图片同步保存关联和数量，切换相邻图片，删完保留空订单和原图', () async {
    final orderId = controller.current!.id;
    final first = controller.selectedImage!;
    final firstPath = controller.imagePath(first);
    final bytes = await File(firstPath).readAsBytes();
    await controller.setTemplate('A03', true);
    await controller.importPaths([firstPath], ImageSource.localFile);
    final second = controller.selectedImage!;
    controller.selectImage(first.id);

    expect(await controller.deleteImage(first.id), isTrue);
    expect(controller.selectedImage!.id, second.id);
    expect(controller.current!.taskCount, 0);
    expect(controller.current!.unassignedCount, 1);
    expect(controller.orders.single.images.single.id, second.id);
    expect((await repository.load(orderId)).images.single.id, second.id);
    expect(await File(firstPath).readAsBytes(), bytes);

    expect(await controller.deleteImage(second.id), isTrue);
    expect(controller.selectedImage, isNull);
    expect(controller.current!.id, orderId);
    expect(controller.current!.images, isEmpty);
    expect((await repository.load(orderId)).images, isEmpty);
    expect(await File(second.filePath!).readAsBytes(), bytes);
  });

  test('删除图片失败或编号不存在时保留图片和模板关联，可重试', () async {
    await controller.setTemplate('A03', true);
    final image = controller.selectedImage!;
    repository.failWrites = true;
    expect(await controller.deleteImage(image.id), isFalse);
    expect(controller.error, contains('disk full'));
    expect(controller.selectedImage!.id, image.id);
    expect(controller.current!.taskCount, 1);
    expect(
      (await repository.load(controller.current!.id)).images.single.templateIds,
      {'模板混合.png'},
    );
    repository.failWrites = false;
    expect(await controller.deleteImage('missing'), isFalse);
    expect(controller.current!.images.single.id, image.id);
    expect(await controller.deleteImage(image.id), isTrue);
    expect(controller.error, isNull);
  });

  test('删除保留旧版原图且不影响其他订单，失败时保持当前订单', () async {
    final currentId = controller.current!.id;
    final legacy = await repository.create('旧订单');
    final bytes = await File(
      controller.imagePath(controller.selectedImage!),
    ).readAsBytes();
    final original = File(
      '${repository.root.path}/orders/${legacy.id}/originals/legacy.png',
    );
    await original.parent.create(recursive: true);
    await original.writeAsBytes(bytes);
    await repository.save(
      legacy.addImage(
        OrderImage(
          id: 'legacy',
          originalName: 'legacy.png',
          storedName: 'legacy.png',
          byteLength: bytes.length,
          source: ImageSource.localFile,
        ),
      ),
    );
    await controller.initialize();
    expect(await controller.deleteOrder(legacy.id), isTrue);
    expect(controller.current!.id, currentId);
    expect(controller.orders.map((order) => order.id), [currentId]);
    final archived = (await Directory(
      '${repository.root.path}/trash',
    ).list().toList()).single;
    expect(
      await File('${archived.path}/originals/legacy.png').readAsBytes(),
      bytes,
    );
    expect(await File('${archived.path}/order.json').exists(), isTrue);

    // An unavailable recycle directory must not remove the remaining order.
    // Move only this test's archive outside the path used for the next operation.
    await Directory(
      '${repository.root.path}/trash',
    ).rename('${temporary.path}/saved-trash');
    await File('${repository.root.path}/trash').writeAsString('blocked');
    expect(await controller.deleteOrder(currentId), isFalse);
    expect(controller.current!.id, currentId);
    expect(controller.selectedImage, isNotNull);
    expect(controller.orders.single.id, currentId);
    expect((await repository.load(currentId)).images, hasLength(1));
    await expectLater(repository.delete('../outside'), throwsArgumentError);
  });
}
