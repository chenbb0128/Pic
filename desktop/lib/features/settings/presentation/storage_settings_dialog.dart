import 'package:flutter/material.dart';

import '../../../platform/desktop_gateway.dart';
import '../storage_settings.dart';

class StorageSettingsDialog extends StatefulWidget {
  const StorageSettingsDialog({
    super.key,
    required this.storage,
    required this.desktop,
  });

  final StorageSettings storage;
  final DesktopGateway desktop;

  @override
  State<StorageSettingsDialog> createState() => _StorageSettingsDialogState();
}

class _StorageSettingsDialogState extends State<StorageSettingsDialog> {
  late final _path = TextEditingController(text: widget.storage.imageRootPath);
  late String? _error = widget.storage.loadError;
  bool _busy = false;

  @override
  void dispose() {
    _path.dispose();
    super.dispose();
  }

  Future<void> _chooseDirectory() async {
    setState(() => _busy = true);
    try {
      final path = await widget.desktop.chooseDirectory();
      if (mounted && path != null) {
        setState(() {
          _path.text = path;
          _error = null;
        });
      }
    } on Object catch (error) {
      if (mounted) setState(() => _error = '选择目录失败：$error');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _save() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.storage.saveImageRoot(_path.text);
      if (mounted) Navigator.pop(context, true);
    } on Object catch (error) {
      if (mounted) setState(() => _error = '保存失败，原设置仍有效：$error');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: !_busy,
    child: AlertDialog(
      title: const Text('保存设置'),
      content: SizedBox(
        width: 480,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              TextField(
                controller: _path,
                readOnly: true,
                minLines: 1,
                maxLines: 3,
                decoration: const InputDecoration(
                  labelText: '图片保存目录',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 12),
              OutlinedButton.icon(
                onPressed: _busy ? null : _chooseDirectory,
                icon: const Icon(Icons.folder_open),
                label: const Text('选择文件夹'),
              ),
              const SizedBox(height: 12),
              Text(
                '自动按「日期 / 订单」归档，已有图片保留原位置。',
                style: Theme.of(context).textTheme.bodySmall,
              ),
              if (_error != null) ...[
                const SizedBox(height: 12),
                SelectableText(
                  _error!,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ],
              if (_busy) ...[
                const SizedBox(height: 12),
                const LinearProgressIndicator(),
              ],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.pop(context, false),
          child: const Text('取消'),
        ),
        FilledButton(onPressed: _busy ? null : _save, child: const Text('保存')),
      ],
    ),
  );
}
