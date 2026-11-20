import 'package:flutter/foundation.dart';

import '../../templates/template_definition.dart';
import '../domain/order_document.dart';
import '../domain/order_image.dart';
import '../domain/order_repository.dart';

class OrderController extends ChangeNotifier {
  OrderController({
    required this.repository,
    required List<TemplateDefinition> templates,
  }) : templates = List.unmodifiable(templates);

  final OrderRepository repository;
  final List<TemplateDefinition> templates;
  List<OrderDocument> _orders = [];
  OrderDocument? _current;
  String? _selectedImageId;
  String? _error;
  bool _busy = false;
  bool _disposed = false;

  List<OrderDocument> get orders => List.unmodifiable(_orders);
  OrderDocument? get current => _current;
  String? get error => _error;
  bool get busy => _busy;

  OrderImage? get selectedImage {
    for (final image in _current?.images ?? <OrderImage>[]) {
      if (image.id == _selectedImageId) return image;
    }
    return null;
  }

  Future<bool> initialize() => _run(() async {
    _orders = await repository.listOrders();
  });

  Future<bool> openOrCreate(String number) => _run(() async {
    final order = await repository.create(number);
    final orders = await repository.listOrders();
    _current = order;
    _orders = orders;
    _selectedImageId = order.images.firstOrNull?.id;
  });

  Future<bool> openOrder(String id) => _run(() async {
    final order = await repository.load(id);
    _current = order;
    _selectedImageId = order.images.firstOrNull?.id;
  });

  Future<bool> deleteOrder(String id) => _run(() async {
    if (!_orders.any((order) => order.id == id)) {
      throw StateError('订单不存在，请重新读取列表。');
    }
    await repository.delete(id);
    _orders = _orders.where((order) => order.id != id).toList();
    if (_current?.id == id) {
      _current = null;
      _selectedImageId = null;
    }
  });

  Future<bool> deleteImage(String imageId) => _run(() async {
    final order = _current;
    if (order == null) throw StateError('请先打开订单');
    final index = order.images.indexWhere((image) => image.id == imageId);
    final updated = order.removeImage(imageId);
    // Remove only the association. Keep the original file and update the UI
    // only after the new order snapshot is saved successfully.
    await repository.save(updated);
    _current = updated;
    _orders = [updated, ..._orders.where((item) => item.id != updated.id)];
    if (_selectedImageId == imageId) {
      _selectedImageId = updated.images.isEmpty
          ? null
          : updated
                .images[index < updated.images.length ? index : index - 1]
                .id;
    }
  });

  void selectImage(String id) {
    if (_busy || !(_current?.images.any((image) => image.id == id) ?? false))
      return;
    _selectedImageId = id;
    _notify();
  }

  Future<bool> importPaths(List<String> paths, ImageSource source) =>
      importPreparedPaths(() async => paths, source);

  Future<bool> importPreparedPaths(
    Future<List<String>> Function() prepare,
    ImageSource source,
  ) => _run(() async {
    if (_current == null) throw StateError('请先打开或新建订单，再导入图片。');
    // Download while busy: switching orders cannot reassign an in-flight photo.
    final paths = await prepare();
    // Commit each successful import immediately. A later failure never hides it.
    try {
      for (final path in paths) {
        _current = await repository.importImage(_current!, path, source);
        _selectedImageId = _current!.images.last.id;
      }
    } finally {
      final order = _current!;
      _orders = [order, ..._orders.where((item) => item.id != order.id)];
    }
  });

  /// 排单收件箱入库：按订单号找单或建单后导入图片。
  /// 返回 null 表示成功；返回 `busy` 表示控制器忙，调用方稍后重试；
  /// 其他返回值为失败原因。不依赖也不抢占当前选中订单。
  Future<String?> ingestPaidan({
    required String orderNumber,
    required String sourcePath,
  }) async {
    if (_busy) return 'busy';
    _busy = true;
    _error = null;
    _notify();
    try {
      final order = await repository.create(orderNumber);
      final updated = await repository.importImage(
        order,
        sourcePath,
        ImageSource.paidan,
      );
      _orders = [updated, ..._orders.where((item) => item.id != updated.id)];
      // 用户恰好开着同一订单时，替换为最新快照；否则不动当前选择。
      if (_current?.id == updated.id) {
        _current = updated;
        _selectedImageId = updated.images.last.id;
      }
      return null;
    } on Object catch (error) {
      return error.toString();
    } finally {
      _busy = false;
      _notify();
    }
  }

  Future<bool> setTemplate(String templateId, bool enabled) =>
      setTemplateQuantity(
        templateId,
        enabled
            ? selectedImage?.templateQuantities[canonicalTemplateId(
                    templateId,
                  )] ??
                  1
            : 0,
      );

  Future<bool> setTemplateQuantity(String templateId, int quantity) => _run(
    () async {
      final image = selectedImage;
      if (image == null || _current == null) throw StateError('请先选择图片');
      final id = canonicalTemplateId(templateId);
      if (!templates.any((template) => template.id == id))
        throw ArgumentError('模板不存在');
      final updated = _current!.assignTemplateQuantity(image.id, id, quantity);
      await repository.save(updated);
      _current = updated;
      _orders = [updated, ..._orders.where((order) => order.id != updated.id)];
    },
  );

  Future<bool> setImageNote(String imageId, String note) => _run(() async {
    final order = _current;
    if (order == null) throw StateError('请先打开订单');
    final image = order.images.where((item) => item.id == imageId).firstOrNull;
    if (image == null) throw ArgumentError('图片不存在');
    if (image.note == note) return;
    final updated = order.setImageNote(imageId, note);
    await repository.save(updated);
    _current = updated;
    _orders = [updated, ..._orders.where((item) => item.id != updated.id)];
  });

  String imagePath(OrderImage image) =>
      repository.imagePath(_current!.id, image);

  String templateName(String id) =>
      templates.where((template) => template.matches(id)).firstOrNull?.name ??
      id;

  void reportError(String message) {
    _error = message;
    _notify();
  }

  Future<bool> _run(Future<void> Function() operation) async {
    if (_busy) {
      reportError('正在处理当前操作，请完成后重试。');
      return false;
    }
    _busy = true;
    _error = null;
    _notify();
    try {
      await operation();
      return true;
    } on Object catch (error) {
      _error = error.toString();
      return false;
    } finally {
      _busy = false;
      _notify();
    }
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
