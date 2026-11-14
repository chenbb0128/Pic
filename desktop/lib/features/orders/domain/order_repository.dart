import 'order_document.dart';
import 'order_image.dart';

abstract interface class OrderRepository {
  Future<List<OrderDocument>> listOrders();
  Future<OrderDocument> create(String orderNumber);
  Future<OrderDocument> load(String id);
  Future<void> save(OrderDocument order);

  /// Remove an order from the active library, preserving its files in trash.
  Future<void> delete(String id);
  Future<OrderDocument> importImage(
    OrderDocument order,
    String sourcePath,
    ImageSource source,
  );
  String imagePath(String orderId, OrderImage image);
}
