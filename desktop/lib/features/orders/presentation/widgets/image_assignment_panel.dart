import 'dart:io';

import 'package:flutter/material.dart';

import '../../../../platform/desktop_gateway.dart';
import '../../../templates/template_definition.dart';
import '../../application/order_controller.dart';
import 'file_drag_source.dart';

class ImageAssignmentPanel extends StatefulWidget {
  const ImageAssignmentPanel({
    super.key,
    required this.controller,
    required this.desktop,
  });
  final OrderController controller;
  final DesktopGateway desktop;

  @override
  State<ImageAssignmentPanel> createState() => _ImageAssignmentPanelState();
}

class _ImageAssignmentPanelState extends State<ImageAssignmentPanel> {
  bool _saving = false;
  OrderController get controller => widget.controller;

  Future<void> _openWebTemplate(TemplateDefinition template) async {
    try {
      await widget.desktop.openWebTemplate(template.id);
    } on Object catch (error) {
      if (mounted) controller.reportError('打开制作页面失败：$error');
    }
  }

  Future<void> _saveImage() async {
    final image = controller.selectedImage;
    if (image == null || _saving) return;
    final path = controller.imagePath(image);
    setState(() => _saving = true);
    try {
      final destination = await widget.desktop.saveImageAs(
        path,
        image.originalName,
      );
      if (mounted && destination != null) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('图片已保存')));
      }
    } on Object catch (error) {
      if (mounted) controller.reportError('另存为失败：$error');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final image = controller.selectedImage;
    if (image == null) return const Center(child: Text('选择一张图片'));
    final number =
        controller.current!.images.indexWhere((item) => item.id == image.id) +
        1;
    final fileSize = image.byteLength >= 1024 * 1024
        ? '${(image.byteLength / (1024 * 1024)).toStringAsFixed(2)} MB'
        : '${(image.byteLength / 1024).toStringAsFixed(1)} KB';
    final knownIds = controller.templates
        .map((template) => template.id)
        .toSet();
    final selectedIds = image.templateIds.map(canonicalTemplateId).toSet();
    final unknownIds = selectedIds.difference(knownIds);
    final selectedTemplates = controller.templates
        .where((template) => selectedIds.contains(template.id))
        .toList();
    return LayoutBuilder(
      builder: (context, constraints) => ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Row(
            children: [
              Tooltip(
                message: image.originalName,
                child: Text(
                  '图片 $number',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              const SizedBox(width: 10),
              Text(fileSize, style: Theme.of(context).textTheme.bodySmall),
              const Spacer(),
              TextButton.icon(
                onPressed: controller.busy || _saving ? null : _saveImage,
                icon: const Icon(Icons.file_download_outlined, size: 18),
                label: Text(_saving ? '保存中…' : '另存为'),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Container(
            height: (constraints.maxHeight - 300).clamp(200.0, 520.0),
            clipBehavior: Clip.antiAlias,
            decoration: BoxDecoration(
              color: Colors.white,
              border: Border.all(color: const Color(0xFFE7E9F0)),
              borderRadius: BorderRadius.circular(12),
            ),
            child: FileDragSource(
              path: controller.imagePath(image),
              desktop: widget.desktop,
              enabled: !controller.busy && !_saving,
              onError: controller.reportError,
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Image.file(
                  File(controller.imagePath(image)),
                  fit: BoxFit.contain,
                  cacheWidth: 1000,
                  errorBuilder: (_, _, _) =>
                      const Center(child: Text('图片无法预览')),
                ),
              ),
            ),
          ),
          const SizedBox(height: 20),
          Row(
            children: [
              Text('制作模板', style: Theme.of(context).textTheme.titleSmall),
              const SizedBox(width: 8),
              Text('可多选', style: Theme.of(context).textTheme.bodySmall),
              const Spacer(),
              PopupMenuButton<TemplateDefinition>(
                tooltip: '打开 web 制作',
                enabled: !controller.busy,
                onSelected: _openWebTemplate,
                itemBuilder: (context) => [
                  for (final template
                      in selectedTemplates.isEmpty
                          ? controller.templates
                          : selectedTemplates)
                    PopupMenuItem(value: template, child: Text(template.name)),
                ],
                child: const Padding(
                  padding: EdgeInsets.symmetric(horizontal: 8, vertical: 10),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text('去制作'),
                      SizedBox(width: 6),
                      Icon(Icons.open_in_new, size: 16),
                    ],
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 10,
            runSpacing: 8,
            children: [
              for (final template in controller.templates)
                FilterChip(
                  label: Text(template.name),
                  selected: selectedIds.contains(template.id),
                  onSelected: controller.busy
                      ? null
                      : (selected) =>
                            controller.setTemplate(template.id, selected),
                ),
            ],
          ),
          if (unknownIds.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: Text('其他已选模板：${unknownIds.join('、')}'),
            ),
        ],
      ),
    );
  }
}
