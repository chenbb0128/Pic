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

  Future<bool> setTemplate(String templateId, bool enabled) => _run(() async {
    final image = selectedImage;
    if (image == null || _current == null) throw StateError('请先选择图片');
    final id = canonicalTemplateId(templateId);
    if (!templates.any((template) => template.id == id))
      throw ArgumentError('模板不存在');
    final ids = image.templateIds.map(canonicalTemplateId).toSet();
    if (enabled) {
      ids.add(id);
    } else {
      ids.remove(id);
    }
    final updated = _current!.assignTemplates(image.id, ids);
    await repository.save(updated);
    _current = updated;
    _orders = [updated, ..._orders.where((order) => order.id != updated.id)];
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
