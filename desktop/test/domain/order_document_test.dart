import 'package:flutter_test/flutter_test.dart';
import 'package:pic_order_desktop/features/orders/domain/order_document.dart';
import 'package:pic_order_desktop/features/orders/domain/order_image.dart';

void main() {
  test('订单号保留前导零，空白订单号拒绝', () {
    expect(
      OrderDocument.create(id: 'id', orderNumber: ' 00123 ').orderNumber,
      '00123',
    );
    expect(
      () => OrderDocument.create(id: 'id', orderNumber: '  '),
      throwsArgumentError,
    );
  });

  test('同图可以关联多个模板，下一张图片保持未分配', () {
    final order = OrderDocument.create(id: 'id', orderNumber: '610')
        .addImage(
          OrderImage(
            id: 'one',
            originalName: '头像.png',
            storedName: 'one.png',
            byteLength: 20,
            source: ImageSource.localFile,
          ),
        )
        .addImage(
          OrderImage(
            id: 'two',
            originalName: '头像2.png',
            storedName: 'two.png',
            byteLength: 30,
            source: ImageSource.localFile,
          ),
        );
    final updated = order.assignTemplates('one', {'A08', 'A03'});
    expect(updated.images.first.templateIds, unorderedEquals(['A08', 'A03']));
    expect(updated.images.last.templateIds, isEmpty);
    expect(order.images.first.templateIds, isEmpty);
    expect(updated.images.first.originalVerified, isFalse);
    expect(
      () => updated.assignTemplates('missing', {'A03'}),
      throwsArgumentError,
    );
  });
}
