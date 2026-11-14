import 'dart:async';
import 'dart:io';

/// Resolve only the EVA image endpoint verified against "download original".
/// No cookies, login data, image re-encoding, or arbitrary URL rewriting.
class EvaOriginalImageLoader {
  EvaOriginalImageLoader(this.incomingDirectory);

  final Directory incomingDirectory;
  final Map<String, File> _received = {};
  static const _maximumBytes = 512 * 1024 * 1024;

  Uri? originalUri(String filename, Uri source) {
    if (source.scheme != 'https' ||
        source.host != 'qimg.xiaohongshu.com' ||
        source.userInfo.isNotEmpty ||
        source.port != 443 ||
        !RegExp(r'^/arkgoods/[a-zA-Z0-9]+$').hasMatch(source.path))
      return null;
    final id = source.pathSegments.last;
    final basename = filename.replaceFirst(RegExp(r'\.[^.]+$'), '');
    if (basename != id) throw const FormatException('拖入图片与图片地址不匹配，未导入缩略图。');
    // Retain unrelated parameters (including signed parameters) verbatim.
    final parts = source.query
        .split('&')
        .where(
          (part) =>
              part.isNotEmpty &&
              !Uri.decodeComponent(part).startsWith('imageView2/'),
        )
        .toList();
    return Uri.parse(
      'https://qimg.xiaohongshu.com${source.path}${parts.isEmpty ? '' : '?${parts.join('&')}'}',
    );
  }

  Future<File?> prepare(String sourcePath, Uri? source) async {
    final filename = File(sourcePath).uri.pathSegments.last;
    if (source == null) return null;
    final uri = originalUri(filename, source);
    if (uri == null) return null;
    await incomingDirectory.create(recursive: true);
    final directory = await incomingDirectory.createTemp('original-');
    final file = File('${directory.path}/$filename');
    final partial = File('${file.path}.partial');
    final client = HttpClient()
      ..connectionTimeout = const Duration(seconds: 12);
    IOSink? output;
    try {
      final request = await client
          .getUrl(uri)
          .timeout(const Duration(seconds: 15));
      request.followRedirects = false;
      final response = await request.close().timeout(
        const Duration(seconds: 30),
      );
      if (response.statusCode != HttpStatus.ok) {
        throw HttpException('原图服务返回 ${response.statusCode}，未导入缩略图。');
      }
      if (response.contentLength > _maximumBytes)
        throw const FormatException('原图超过 512 MB。');
      final mime = response.headers.contentType?.mimeType;
      if (mime != null &&
          !mime.startsWith('image/') &&
          mime != 'application/octet-stream') {
        throw const FormatException('原图服务返回的内容不是图片。');
      }
      output = partial.openWrite();
      var bytes = 0;
      await for (final chunk in response.timeout(const Duration(seconds: 30))) {
        bytes += chunk.length;
        if (bytes > _maximumBytes) throw const FormatException('原图超过 512 MB。');
        output.add(chunk);
      }
      await output.flush();
      await output.close();
      output = null;
      if (bytes == 0 ||
          (response.contentLength >= 0 && bytes != response.contentLength)) {
        throw const FormatException('原图下载不完整，未导入缩略图。');
      }
      final complete = await partial.rename(file.path);
      _received[sourcePath] = complete;
      return complete;
    } on Object {
      if (output != null) await output.close();
      if (await partial.exists()) await partial.delete();
      if (await directory.exists()) await directory.delete();
      rethrow;
    } finally {
      client.close(force: true);
    }
  }

  Future<void> release(List<String> sourcePaths) async {
    for (final path in sourcePaths) {
      final file = _received.remove(path);
      if (file == null) continue;
      // These exact files were created above, and the order is now committed.
      if (await file.exists()) await file.delete();
      await file.parent.delete();
    }
  }
}
