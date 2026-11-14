import 'dart:async';

import 'package:flutter/material.dart';

import '../../../platform/desktop_gateway.dart';
import '../../settings/presentation/storage_settings_dialog.dart';
import '../../settings/storage_settings.dart';
import '../application/order_controller.dart';
import '../domain/order_document.dart';
import '../domain/order_image.dart';
import 'widgets/image_assignment_panel.dart';
import 'widgets/order_image_list.dart';
import 'widgets/order_list.dart';

class WorkbenchPage extends StatefulWidget {
  const WorkbenchPage({
    super.key,
    required this.controller,
    required this.desktop,
    required this.storage,
  });
  final OrderController controller;
  final DesktopGateway desktop;
  final StorageSettings storage;

  @override
  State<WorkbenchPage> createState() => _WorkbenchPageState();
}

class _WorkbenchPageState extends State<WorkbenchPage> {
  final _orderNumber = TextEditingController();
  StreamSubscription<List<String>>? _dropSubscription;
  StreamSubscription<String>? _warningSubscription;
  bool _pinned = false;
  bool _choosingFiles = false;
  bool _settingsOpen = false;
  bool _confirmingDelete = false;

  OrderController get controller => widget.controller;

  @override
  void initState() {
    super.initState();
    _dropSubscription = widget.desktop.droppedFiles.listen((paths) {
      unawaited(_importDroppedFiles(paths));
    });
    _warningSubscription = widget.desktop.dropWarnings.listen(
      controller.reportError,
    );
    unawaited(_initialize());
  }

  Future<void> _initialize() async {
    await controller.initialize();
    if (mounted && widget.storage.loadError != null) {
      controller.reportError(widget.storage.loadError!);
    }
  }

  @override
  void dispose() {
    unawaited(_dropSubscription?.cancel());
    unawaited(_warningSubscription?.cancel());
    _orderNumber.dispose();
    super.dispose();
  }

  Future<void> _importDroppedFiles(List<String> paths) async {
    if (_settingsOpen || _confirmingDelete) {
      controller.reportError('请先关闭当前对话框，再拖入图片。');
      return;
    }
    final saved = await controller.importPreparedPaths(
      () => widget.desktop.prepareDroppedFiles(paths),
      ImageSource.desktopDrop,
    );
    if (!saved) return;
    try {
      await widget.desktop.releaseDroppedFiles(paths);
    } on Object catch (error) {
      if (mounted) controller.reportError('图片已保存，接收缓存未能清理：$error');
    }
  }

  Future<void> _chooseImages() async {
    setState(() => _choosingFiles = true);
    try {
      final paths = await widget.desktop.chooseImages();
      if (mounted && paths.isNotEmpty)
        await controller.importPaths(paths, ImageSource.localFile);
    } on Object catch (error) {
      if (mounted) controller.reportError('选择图片失败：$error');
    } finally {
      if (mounted) setState(() => _choosingFiles = false);
    }
  }

  Future<void> _togglePin() async {
    try {
      await widget.desktop.setAlwaysOnTop(!_pinned);
      if (mounted) setState(() => _pinned = !_pinned);
    } on Object catch (error) {
      if (mounted) controller.reportError('窗口置顶失败：$error');
    }
  }

  Future<void> _openSettings() async {
    setState(() => _settingsOpen = true);
    try {
      final saved = await showDialog<bool>(
        context: context,
        barrierDismissible: false,
        builder: (context) => StorageSettingsDialog(
          storage: widget.storage,
          desktop: widget.desktop,
        ),
      );
      if (mounted && saved == true) {
        // Clear a previous configuration error and keep the current order open.
        await controller.initialize();
        if (mounted) {
          ScaffoldMessenger.of(
            context,
          ).showSnackBar(const SnackBar(content: Text('保存目录已更新，新图片将按天归档。')));
        }
      }
    } finally {
      if (mounted) setState(() => _settingsOpen = false);
    }
  }

  Future<void> _deleteOrder(OrderDocument order) async {
    if (controller.busy || _choosingFiles || _settingsOpen || _confirmingDelete)
      return;
    setState(() => _confirmingDelete = true);
    try {
      final confirmed = await showDialog<bool>(
        context: context,
        barrierDismissible: false,
        builder: (context) => AlertDialog(
          title: const Text('删除订单'),
          content: Text('订单 ${order.orderNumber}\n\n订单将移至本地回收目录，原图保留。'),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('取消'),
            ),
            FilledButton(
              style: FilledButton.styleFrom(
                backgroundColor: Theme.of(context).colorScheme.error,
              ),
              onPressed: () => Navigator.pop(context, true),
              child: const Text('删除'),
            ),
          ],
        ),
      );
      if (!mounted || confirmed != true) return;
      final deleted = await controller.deleteOrder(order.id);
      if (mounted && deleted) {
        if (_orderNumber.text.trim() == order.orderNumber) _orderNumber.clear();
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('订单已删除，原图保留')));
      }
    } finally {
      if (mounted) setState(() => _confirmingDelete = false);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) {
      final busy =
          controller.busy ||
          _choosingFiles ||
          _settingsOpen ||
          _confirmingDelete;
      return Scaffold(
        appBar: AppBar(
          title: const Text('订单素材台'),
          actions: [
            IconButton(
              onPressed: busy ? null : _openSettings,
              icon: const Icon(Icons.settings_outlined),
              tooltip: '保存设置',
            ),
            IconButton(
              onPressed: _togglePin,
              isSelected: _pinned,
              icon: Icon(_pinned ? Icons.push_pin : Icons.push_pin_outlined),
              tooltip: _pinned ? '取消置顶' : '窗口置顶',
            ),
            const SizedBox(width: 12),
          ],
        ),
        body: Column(
          children: [
            Container(
              padding: const EdgeInsets.fromLTRB(20, 4, 20, 16),
              decoration: const BoxDecoration(
                color: Colors.white,
                border: Border(bottom: BorderSide(color: Color(0xFFE7E9F0))),
              ),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _orderNumber,
                      enabled: !busy,
                      decoration: const InputDecoration(
                        labelText: '订单号',
                        hintText: '粘贴客户订单号',
                        border: OutlineInputBorder(),
                        isDense: true,
                      ),
                      onSubmitted: busy
                          ? null
                          : (number) => controller.openOrCreate(number),
                    ),
                  ),
                  const SizedBox(width: 12),
                  FilledButton(
                    onPressed: busy
                        ? null
                        : () => controller.openOrCreate(_orderNumber.text),
                    child: const Text('打开／新建'),
                  ),
                  const SizedBox(width: 12),
                  OutlinedButton.icon(
                    onPressed: busy || controller.current == null
                        ? null
                        : _chooseImages,
                    icon: const Icon(Icons.add_photo_alternate_outlined),
                    label: const Text('导入图片'),
                  ),
                ],
              ),
            ),
            if (controller.error != null)
              MaterialBanner(
                content: SelectableText(controller.error!),
                backgroundColor: Theme.of(context).colorScheme.errorContainer,
                actions: [
                  TextButton(
                    onPressed: busy ? null : () => controller.initialize(),
                    child: const Text('重试'),
                  ),
                ],
              ),
            if (controller.busy) const LinearProgressIndicator(minHeight: 2),
            Expanded(
              child: LayoutBuilder(
                builder: (context, constraints) {
                  final wide = constraints.maxWidth >= 1000;
                  return Row(
                    children: [
                      if (wide) ...[
                        SizedBox(
                          width: 220,
                          child: OrderList(
                            controller: controller,
                            onDelete: _deleteOrder,
                            enabled: !busy,
                          ),
                        ),
                        const VerticalDivider(width: 1),
                      ],
                      Expanded(
                        child: Column(
                          children: [
                            if (!wide)
                              Padding(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 16,
                                ),
                                child: Row(
                                  children: [
                                    Expanded(
                                      child: DropdownButton<String>(
                                        isExpanded: true,
                                        hint: const Text('选择已有订单'),
                                        value:
                                            controller.orders.any(
                                              (order) =>
                                                  order.id ==
                                                  controller.current?.id,
                                            )
                                            ? controller.current?.id
                                            : null,
                                        items: [
                                          for (final order in controller.orders)
                                            DropdownMenuItem(
                                              value: order.id,
                                              child: Text(
                                                '${order.orderNumber} · ${order.images.length} 张图片',
                                              ),
                                            ),
                                        ],
                                        onChanged: busy
                                            ? null
                                            : (id) {
                                                if (id != null)
                                                  unawaited(
                                                    controller.openOrder(id),
                                                  );
                                              },
                                      ),
                                    ),
                                    if (controller.current != null)
                                      IconButton(
                                        tooltip: '删除订单',
                                        icon: const Icon(
                                          Icons.delete_outline,
                                          size: 20,
                                        ),
                                        onPressed: busy
                                            ? null
                                            : () => _deleteOrder(
                                                controller.current!,
                                              ),
                                      ),
                                  ],
                                ),
                              ),
                            Expanded(child: _orderContent(context)),
                          ],
                        ),
                      ),
                    ],
                  );
                },
              ),
            ),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
              decoration: const BoxDecoration(
                color: Colors.white,
                border: Border(top: BorderSide(color: Color(0xFFE7E9F0))),
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      controller.current == null
                          ? ''
                          : '订单 ${controller.current!.orderNumber}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ),
                  if (controller.current != null) ...[
                    Text(
                      '${controller.current!.images.length} 张图片 · ${controller.current!.taskCount} 份制作任务 · ${controller.current!.unassignedCount} 张待分配',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                    const SizedBox(width: 20),
                  ],
                  Icon(
                    controller.busy
                        ? Icons.more_horiz
                        : controller.error != null
                        ? Icons.error_outline
                        : Icons.check_circle_outline,
                    size: 15,
                    color: controller.error != null
                        ? Theme.of(context).colorScheme.error
                        : const Color(0xFF6C7584),
                  ),
                  const SizedBox(width: 5),
                  Text(
                    controller.busy
                        ? '处理中'
                        : controller.error != null
                        ? '未完成'
                        : controller.current == null
                        ? '就绪'
                        : '已保存',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ),
            ),
          ],
        ),
      );
    },
  );

  Widget _orderContent(BuildContext context) {
    final order = controller.current;
    if (order == null || order.images.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                Icons.photo_library_outlined,
                size: 48,
                color: const Color(0xFFB2B8CA),
              ),
              const SizedBox(height: 16),
              Text(
                order == null ? '输入订单号，开始整理图片' : '拖入图片，或点击「导入图片」',
                style: Theme.of(context).textTheme.titleMedium,
                textAlign: TextAlign.center,
              ),
            ],
          ),
        ),
      );
    }
    return Row(
      children: [
        SizedBox(
          width: 148,
          child: OrderImageList(
            controller: controller,
            desktop: widget.desktop,
          ),
        ),
        const VerticalDivider(width: 1),
        Expanded(
          child: ImageAssignmentPanel(
            controller: controller,
            desktop: widget.desktop,
          ),
        ),
      ],
    );
  }
}
