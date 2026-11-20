import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:pic_order_desktop/features/orders/data/order_codec.dart';

void main() {
  const legacy = '''{
    "schemaVersion": 1,
    "id": "order",
    "orderNumber": "001",
    "createdAt": "2026-11-14T00:00:00Z",
    "updatedAt": "2026-11-14T00:00:00Z",
    "images": [{
      "id": "photo", "originalName": "photo.png", "storedName": "photo.png",
      "byteLength": 20, "source": "localFile", "originalVerified": false,
      "templateIds": ["A03", "A08"]
    }]
  }''';

  test('旧订单无份数字段时每个模板默认一份，新增份数往返保存且兼容旧编号', () {
    final codec = OrderCodec();
    final oldOrder = codec.decode(legacy, 'order');
    expect(oldOrder.taskCount, 2);
    expect(oldOrder.images.single.templateQuantities, {
      '模板混合.png': 1,
      '缤纷糖果.png': 1,
    });
    expect(oldOrder.images.single.note, isEmpty);
    final json = jsonDecode(legacy) as Map<String, dynamic>;
    json['images'][0]['templateQuantities'] = {'A03': 3, 'A08': 2};
    final updated = codec.decode(jsonEncode(json), 'order');
    expect(updated.taskCount, 5);
    final reopened = codec.decode(codec.encode(updated), 'order');
    expect(reopened.images.single.templateQuantities, {
      '模板混合.png': 3,
      '缤纷糖果.png': 2,
    });
  });

  test('图片备注往返保存，超长备注明确拒绝', () {
    final json = jsonDecode(legacy) as Map<String, dynamic>;
    json['images'][0]['note'] = '加急\n客户要求蓝色模板';
    final order = OrderCodec().decode(jsonEncode(json), 'order');
    expect(order.images.single.note, '加急\n客户要求蓝色模板');
    final reopened = OrderCodec().decode(OrderCodec().encode(order), 'order');
    expect(reopened.images.single.note, order.images.single.note);

    json['images'][0]['note'] = 'a' * 501;
    expect(
      () => OrderCodec().decode(jsonEncode(json), 'order'),
      throwsA(isA<FormatException>()),
    );
  });

  test('快照中的无效份数明确拒绝，不把损坏数据当作一份', () {
    for (final invalid in [0, -1, 1.5, '2']) {
      final json = jsonDecode(legacy) as Map<String, dynamic>;
      json['images'][0]['templateQuantities'] = {'A03': invalid};
      expect(
        () => OrderCodec().decode(jsonEncode(json), 'order'),
        throwsA(isA<FormatException>()),
      );
    }
  });
}
