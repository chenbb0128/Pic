import 'dart:async';

/// OS-boundary contract. Order/domain code never imports MethodChannel.
abstract interface class DesktopGateway {
  Stream<List<String>> get droppedFiles;
  Stream<String> get dropWarnings;
  Future<List<String>> chooseImages();
  Future<String?> chooseDirectory();

  /// Export the saved file without resizing or changing its encoding.
  Future<String?> saveImageAs(String sourcePath, String suggestedName);

  /// Start an OS file drag while the left mouse button is still pressed.
  Future<bool> dragFile(String sourcePath);

  Future<void> openWebTemplate(String templateId);

  /// Acquire an unscaled EVA source before the controller commits an import.
  Future<List<String>> prepareDroppedFiles(List<String> paths);

  /// Clean up native transfer copies only after the repository saved them.
  Future<void> releaseDroppedFiles(List<String> paths);
  Future<void> setAlwaysOnTop(bool enabled);
  Future<void> dispose();
}
