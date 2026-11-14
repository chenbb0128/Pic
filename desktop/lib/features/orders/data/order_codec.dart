import 'dart:convert';
import 'dart:io';

import '../../templates/template_definition.dart';
import '../domain/order_document.dart';
import '../domain/order_image.dart';

class OrderCodec {
  static final _safeName = RegExp(r'^[a-zA-Z0-9_-]+\.(png|jpg|webp|gif|bmp)$');

  String encode(OrderDocument order) =>
      const JsonEncoder.withIndent('  ').convert({
        'schemaVersion': 1,
        'id': order.id,
        'orderNumber': order.orderNumber,
        'createdAt': order.createdAt.toIso8601String(),
        'updatedAt': order.updatedAt.toIso8601String(),
        'images': [
          for (final image in order.images)
            {
              'id': image.id,
              'originalName': image.originalName,
              'storedName': image.storedName,
              'byteLength': image.byteLength,
              'source': image.source.name,
              if (image.filePath != null) 'filePath': image.filePath,
              'originalVerified': image.originalVerified,
              'templateIds': image.templateIds.toList()..sort(),
            },
        ],
      });

  OrderDocument decode(String text, String expectedId) {
    try {
      final json = jsonDecode(text) as Map<String, dynamic>;
      if (json['schemaVersion'] != 1 || json['id'] != expectedId) {
        throw const FormatException('订单记录版本或编号不匹配');
      }
      final images = <OrderImage>[];
      for (final value in json['images'] as List<dynamic>) {
        final image = value as Map<String, dynamic>;
        final storedName = image['storedName'] as String;
        if (!_safeName.hasMatch(storedName))
          throw const FormatException('图片路径无效');
        final length = image['byteLength'] as int;
        if (length <= 0) throw const FormatException('图片大小无效');
        final filePath = image['filePath'] as String?;
        if (filePath != null &&
            (!File(filePath).isAbsolute ||
                File(filePath).uri.pathSegments.last != storedName ||
                File(filePath).uri.pathSegments.contains('..'))) {
          throw const FormatException('图片保存位置无效');
        }
        images.add(
          OrderImage(
            id: image['id'] as String,
            originalName: image['originalName'] as String,
            storedName: storedName,
            byteLength: length,
            source: ImageSource.values.byName(image['source'] as String),
            filePath: filePath,
            originalVerified: image['originalVerified'] as bool,
            templateIds: (image['templateIds'] as List<dynamic>)
                .cast<String>()
                .map(canonicalTemplateId)
                .toSet(),
          ),
        );
      }
      if (images.map((image) => image.id).toSet().length != images.length) {
        throw const FormatException('图片编号重复');
      }
      return OrderDocument(
        id: json['id'] as String,
        orderNumber: json['orderNumber'] as String,
        createdAt: DateTime.parse(json['createdAt'] as String),
        updatedAt: DateTime.parse(json['updatedAt'] as String),
        images: images,
      );
    } on FormatException {
      rethrow;
    } on Object catch (error) {
      throw FormatException('订单记录格式不正确：$error');
    }
  }
}
