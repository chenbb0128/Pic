import 'dart:async';

import 'package:flutter/material.dart';

import '../../../../platform/desktop_gateway.dart';

/// Starts a native file drag after the normal mouse drag threshold is crossed.
class FileDragSource extends StatefulWidget {
  const FileDragSource({
    super.key,
    required this.path,
    required this.desktop,
    required this.onError,
    required this.child,
    this.enabled = true,
  });

  final String path;
  final DesktopGateway desktop;
  final ValueChanged<String> onError;
  final Widget child;
  final bool enabled;

  @override
  State<FileDragSource> createState() => _FileDragSourceState();
}

class _FileDragSourceState extends State<FileDragSource> {
  bool _dragging = false;

  Future<void> _drag() async {
    if (_dragging || !widget.enabled) return;
    setState(() => _dragging = true);
    try {
      await widget.desktop.dragFile(widget.path);
    } on Object catch (error) {
      if (mounted) widget.onError('拖出图片失败：$error');
    } finally {
      if (mounted) setState(() => _dragging = false);
    }
  }

  @override
  Widget build(BuildContext context) => Tooltip(
    message: '按住图片，拖到浏览器上传区或文件夹',
    child: MouseRegion(
      cursor: _dragging
          ? SystemMouseCursors.grabbing
          : widget.enabled
          ? SystemMouseCursors.grab
          : SystemMouseCursors.basic,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onPanStart: widget.enabled && !_dragging
            ? (_) => unawaited(_drag())
            : null,
        child: widget.child,
      ),
    ),
  );
}
