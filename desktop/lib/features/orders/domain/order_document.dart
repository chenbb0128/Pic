import 'order_image.dart';

class OrderDocument {
  OrderDocument({
    required this.id,
    required String orderNumber,
    required this.createdAt,
    required this.updatedAt,
    List<OrderImage> images = const [],
  }) : orderNumber = orderNumber.trim(),
       images = List.unmodifiable(images) {
    if (this.orderNumber.isEmpty) throw ArgumentError('请输入订单号');
  }

  factory OrderDocument.create({
    required String id,
    required String orderNumber,
  }) {
    final now = DateTime.now().toUtc();
    return OrderDocument(
      id: id,
      orderNumber: orderNumber,
      createdAt: now,
      updatedAt: now,
    );
  }

  final String id;
  final String orderNumber;
  final DateTime createdAt;
  final DateTime updatedAt;
  final List<OrderImage> images;

  int get unassignedCount =>
      images.where((image) => image.templateIds.isEmpty).length;
  int get taskCount =>
      images.fold(0, (count, image) => count + image.templateIds.length);

  OrderDocument addImage(OrderImage image) {
    if (images.any((item) => item.id == image.id))
      throw ArgumentError('图片编号重复');
    return _withImages([...images, image]);
  }

  OrderDocument assignTemplates(String imageId, Set<String> ids) {
    if (!images.any((image) => image.id == imageId))
      throw ArgumentError('图片不存在');
    return _withImages([
      for (final image in images)
        if (image.id == imageId) image.withTemplates(ids) else image,
    ]);
  }

  OrderDocument _withImages(List<OrderImage> images) => OrderDocument(
    id: id,
    orderNumber: orderNumber,
    createdAt: createdAt,
    updatedAt: DateTime.now().toUtc(),
    images: images,
  );
}
