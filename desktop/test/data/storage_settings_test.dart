import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pic_order_desktop/features/orders/data/local_order_repository.dart';
import 'package:pic_order_desktop/features/orders/domain/order_image.dart';
import 'package:pic_order_desktop/features/settings/storage_settings.dart';

void main() {
  test('保存目录重开生效、跨天切换，改目录后新旧图片仍可读取', () async {
    final root = await Directory.systemTemp.createTemp('pic-storage-');
    addTearDown(() => root.delete(recursive: true));
    final data = Directory('${root.path}/library');
    final firstRoot = Directory('${root.path}/客户图片');
    final settings = StorageSettings(data);
    await settings.load();
    await settings.saveImageRoot(firstRoot.path);
    final reopenedSettings = StorageSettings(data);
    await reopenedSettings.load();
    expect(reopenedSettings.imageRoot.path, firstRoot.path);

    var now = DateTime.utc(2026, 11, 13, 15, 59);
    final repository = LocalOrderRepository(
      data,
      imageRoot: () => reopenedSettings.imageRoot,
      now: () => now,
    );
    final bytes = base64Decode(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    );
    final source = await File('${root.path}/原图.png').writeAsBytes(bytes);
    var order = await repository.create('001610');

    // Existing snapshots have no filePath and keep their legacy location.
    final legacy = File('${data.path}/orders/${order.id}/originals/old.png');
    await legacy.parent.create(recursive: true);
    await legacy.writeAsBytes(bytes);
    order = order.addImage(
      OrderImage(
        id: 'old',
        originalName: 'old.png',
        storedName: 'old.png',
        byteLength: bytes.length,
        source: ImageSource.localFile,
      ),
    );
    await repository.save(order);
    order = await repository.importImage(
      order,
      source.path,
      ImageSource.localFile,
    );
    order = order.assignTemplates(order.images.last.id, {'A08', 'A03'});
    await repository.save(order);
    now = now.add(const Duration(minutes: 2));
    order = await repository.importImage(
      order,
      source.path,
      ImageSource.localFile,
    );
    final secondRoot = Directory('${root.path}/新保存目录');
    await reopenedSettings.saveImageRoot(secondRoot.path);
    order = await repository.importImage(
      order,
      source.path,
      ImageSource.localFile,
    );

    final finalSettings = StorageSettings(data);
    await finalSettings.load();
    expect(finalSettings.imageRoot.path, secondRoot.path);
    final finalRepository = LocalOrderRepository(
      data,
      imageRoot: () => finalSettings.imageRoot,
    );
    final reopened = await finalRepository.load(order.id);
    final paths = reopened.images
        .map((image) => finalRepository.imagePath(reopened.id, image))
        .toList();
    expect(File(paths[0]).uri, legacy.uri);
    expect(
      paths[1].replaceAll('\\', '/'),
      startsWith('${firstRoot.path.replaceAll('\\', '/')}/2026-11-13/001610_'),
    );
    expect(
      paths[2].replaceAll('\\', '/'),
      startsWith('${firstRoot.path.replaceAll('\\', '/')}/2026-11-14/001610_'),
    );
    expect(
      paths[3].replaceAll('\\', '/'),
      startsWith('${secondRoot.path.replaceAll('\\', '/')}/2026-11-14/001610_'),
    );
    expect(reopened.images[1].templateIds, {'缤纷糖果.png', '模板混合.png'});
    for (final path in paths) {
      expect(await File(path).readAsBytes(), bytes);
    }
  });
}
