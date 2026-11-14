enum ImageSource { localFile, desktopDrop }

class OrderImage {
  OrderImage({
    required this.id,
    required this.originalName,
    required this.storedName,
    required this.byteLength,
    required this.source,
    this.filePath,
    this.originalVerified = false,
    Set<String> templateIds = const {},
  }) : templateIds = Set.unmodifiable(templateIds);

  final String id;
  final String originalName;
  final String storedName;
  final int byteLength;
  final ImageSource source;
  // Null in older snapshots stored inside the order's originals/ directory.
  final String? filePath;
  // Byte-preserving import alone cannot prove EVA supplied the original.
  final bool originalVerified;
  final Set<String> templateIds;

  OrderImage withTemplates(Set<String> ids) {
    if (ids.any((id) => id.trim().isEmpty)) {
      throw ArgumentError('模板编号不能为空');
    }
    return OrderImage(
      id: id,
      originalName: originalName,
      storedName: storedName,
      byteLength: byteLength,
      source: source,
      filePath: filePath,
      originalVerified: originalVerified,
      templateIds: ids,
    );
  }
}
