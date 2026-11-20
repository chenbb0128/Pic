/// 图片进入资料库的途径。
/// `paidan`：千帆客服「进入排单」经收件箱自动入库（排单小助手写入）。
enum ImageSource { localFile, desktopDrop, paidan }

class OrderImage {
  static const maxNoteLength = 500;

  OrderImage({
    required this.id,
    required this.originalName,
    required this.storedName,
    required this.byteLength,
    required this.source,
    this.filePath,
    this.originalVerified = false,
    this.note = '',
    Set<String> templateIds = const {},
    Map<String, int> templateQuantities = const {},
  }) : templateQuantities = Map.unmodifiable({
         for (final id in templateIds) id: 1,
         ...templateQuantities,
       }) {
    if (this.templateQuantities.entries.any(
      (entry) => entry.key.trim().isEmpty || entry.value < 1,
    )) {
      throw ArgumentError('模板编号不能为空，份数必须为正整数');
    }
    if (note.length > maxNoteLength) {
      throw ArgumentError('图片备注不能超过 $maxNoteLength 字');
    }
  }

  final String id;
  final String originalName;
  final String storedName;
  final int byteLength;
  final ImageSource source;
  // Null in older snapshots stored inside the order's originals/ directory.
  final String? filePath;
  // Byte-preserving import alone cannot prove EVA supplied the original.
  final bool originalVerified;
  final String note;
  final Map<String, int> templateQuantities;
  Set<String> get templateIds => Set.unmodifiable(templateQuantities.keys);

  OrderImage withTemplates(Set<String> ids) {
    if (ids.any((id) => id.trim().isEmpty)) {
      throw ArgumentError('模板编号不能为空');
    }
    return _withTemplateQuantities({
      for (final id in ids) id: templateQuantities[id] ?? 1,
    });
  }

  OrderImage withTemplateQuantity(String templateId, int quantity) {
    if (templateId.trim().isEmpty || quantity < 0)
      throw ArgumentError('模板编号不能为空，份数不能为负数');
    final quantities = Map<String, int>.of(templateQuantities);
    if (quantity == 0) {
      quantities.remove(templateId);
    } else {
      quantities[templateId] = quantity;
    }
    return _withTemplateQuantities(quantities);
  }

  OrderImage withNote(String value) => OrderImage(
    id: id,
    originalName: originalName,
    storedName: storedName,
    byteLength: byteLength,
    source: source,
    filePath: filePath,
    originalVerified: originalVerified,
    note: value,
    templateQuantities: templateQuantities,
  );

  OrderImage _withTemplateQuantities(Map<String, int> quantities) => OrderImage(
    id: id,
    originalName: originalName,
    storedName: storedName,
    byteLength: byteLength,
    source: source,
    filePath: filePath,
    originalVerified: originalVerified,
    note: note,
    templateQuantities: quantities,
  );
}
