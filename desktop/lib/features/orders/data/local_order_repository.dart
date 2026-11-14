import 'dart:io';
import 'dart:math';

import '../../settings/storage_settings.dart';
import '../domain/order_document.dart';
import '../domain/order_image.dart';
import '../domain/order_repository.dart';
import 'order_codec.dart';

class LocalOrderRepository implements OrderRepository {
  LocalOrderRepository(
    this.root, {
    Directory Function()? imageRoot,
    DateTime Function()? now,
  }) : _imageRoot = imageRoot ?? (() => Directory('${root.path}/images')),
       _now = now ?? DateTime.now;

  final Directory root;
  final Directory Function() _imageRoot;
  final DateTime Function() _now;
  final _codec = OrderCodec();
  final _random = Random.secure();

  String _newId() => List.generate(
    16,
    (_) => _random.nextInt(256).toRadixString(16).padLeft(2, '0'),
  ).join();

  Directory _orderDirectory(String id) {
    if (!RegExp(r'^[a-f0-9]{32}$').hasMatch(id))
      throw ArgumentError('订单内部编号无效');
    return Directory('${root.path}/orders/$id');
  }

  @override
  Future<List<OrderDocument>> listOrders() async {
    final directory = Directory('${root.path}/orders');
    if (!await directory.exists()) return [];
    final orders = <OrderDocument>[];
    await for (final entry in directory.list(followLinks: false)) {
      if (entry is Directory) {
        final id = entry.uri.pathSegments.where((part) => part.isNotEmpty).last;
        orders.add(await load(id));
      }
    }
    orders.sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
    return orders;
  }

  @override
  Future<OrderDocument> create(String orderNumber) async {
    final number = orderNumber.trim();
    if (number.isEmpty) throw ArgumentError('请输入订单号');
    for (final order in await listOrders()) {
      if (order.orderNumber == number) return order;
    }
    final order = OrderDocument.create(id: _newId(), orderNumber: number);
    await save(order);
    return order;
  }

  @override
  Future<OrderDocument> load(String id) async {
    final file = File('${_orderDirectory(id).path}/order.json');
    try {
      return _codec.decode(await file.readAsString(), id);
    } on Object catch (primaryError) {
      final backup = File('${file.path}.bak');
      if (await backup.exists()) {
        try {
          return _codec.decode(await backup.readAsString(), id);
        } on Object {
          throw FormatException('订单 $id 的记录与备份均无法读取，请保留文件并恢复备份。');
        }
      }
      // Never reinterpret corrupted data as an empty order/library.
      Error.throwWithStackTrace(primaryError, StackTrace.current);
    }
  }

  @override
  Future<void> delete(String id) async {
    final directory = _orderDirectory(id);
    final trash = Directory('${root.path}/trash');
    await trash.create(recursive: true);
    // Same-volume rename preserves metadata, backups and legacy originals as
    // one unit. Dated image files outside this folder are left in place.
    await directory.rename('${trash.path}/$id-${_newId()}');
  }

  @override
  Future<void> save(OrderDocument order) async {
    final target = _orderDirectory(order.id);
    final encoded = _codec.encode(order);
    _codec.decode(encoded, order.id);
    final isNew = !await target.exists();
    // Publish new orders only after a complete snapshot exists. An interrupted
    // first write stays outside orders/, so it cannot poison the order list.
    final directory = isNew
        ? Directory('${root.path}/pending/${order.id}-${_newId()}')
        : target;
    await directory.create(recursive: true);
    final file = File('${directory.path}/order.json');
    final temporary = File('${file.path}.tmp');
    final backup = File('${file.path}.bak');
    await temporary.writeAsString(encoded, flush: true);
    if (await file.exists()) {
      var valid = false;
      try {
        _codec.decode(await file.readAsString(), order.id);
        valid = true;
      } on FormatException {
        // Keep the readable backup when the primary was already corrupted.
      }
      if (valid) {
        if (await backup.exists()) await backup.delete();
        await file.rename(backup.path);
      } else {
        await file.rename('${file.path}.corrupt-${_newId()}');
      }
    }
    await temporary.rename(file.path);
    if (isNew) {
      await target.parent.create(recursive: true);
      await directory.rename(target.path);
    }
  }

  @override
  Future<OrderDocument> importImage(
    OrderDocument order,
    String sourcePath,
    ImageSource source,
  ) async {
    final sourceFile = File(sourcePath);
    final originalName = sourceFile.uri.pathSegments.last;
    final extension = await _imageExtension(sourceFile);
    final id = _newId();
    _orderDirectory(
      order.id,
    ); // Validate the internal ID before using it in a path.
    final label = String.fromCharCodes(
      order.orderNumber
          .replaceAll(RegExp(r'[<>:"/\\|?*\x00-\x1f]'), '_')
          .replaceAll(RegExp(r'^[. ]+|[. ]+$'), '')
          .runes
          .take(40),
    );
    final directory = Directory(
      '${_imageRoot().path}/${storageDate(_now())}/${label.isEmpty ? 'order' : label}_${order.id}',
    );
    await directory.create(recursive: true);
    final copied = await sourceFile.copy('${directory.path}/$id.$extension');
    final image = OrderImage(
      id: id,
      originalName: originalName,
      storedName: '$id.$extension',
      byteLength: await copied.length(),
      source: source,
      filePath: copied.absolute.path,
    );
    final updated = order.addImage(image);
    // Failed metadata writes leave an unreferenced original, never delete a photo.
    await save(updated);
    return updated;
  }

  Future<String> _imageExtension(File file) async {
    final length = await file.length();
    final header = await file
        .openRead(0, min(length, 16))
        .fold<List<int>>([], (all, part) => all..addAll(part));
    bool starts(List<int> signature) =>
        header.length >= signature.length &&
        List.generate(
          signature.length,
          (i) => header[i] == signature[i],
        ).every((same) => same);
    if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return 'png';
    if (starts([255, 216, 255])) return 'jpg';
    if (starts([71, 73, 70, 56, 55, 97]) || starts([71, 73, 70, 56, 57, 97]))
      return 'gif';
    if (starts([66, 77])) return 'bmp';
    if (starts([82, 73, 70, 70]) &&
        header.length >= 12 &&
        String.fromCharCodes(header.sublist(8, 12)) == 'WEBP')
      return 'webp';
    throw const FormatException('请选择 PNG、JPEG、WebP、GIF 或 BMP 图片文件。');
  }

  @override
  String imagePath(String orderId, OrderImage image) {
    if (!RegExp(
      r'^[a-zA-Z0-9_-]+\.(png|jpg|webp|gif|bmp)$',
    ).hasMatch(image.storedName)) {
      throw ArgumentError('图片路径无效');
    }
    final legacy =
        '${_orderDirectory(orderId).path}/originals/${image.storedName}';
    return image.filePath ?? legacy;
  }
}
