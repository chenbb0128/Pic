import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pic_order_desktop/features/orders/application/order_controller.dart';
import 'package:pic_order_desktop/features/orders/data/local_order_repository.dart';
import 'package:pic_order_desktop/features/orders/presentation/workbench_page.dart';
import 'package:pic_order_desktop/features/settings/storage_settings.dart';
import 'package:pic_order_desktop/features/templates/template_definition.dart';
import 'package:pic_order_desktop/platform/desktop_gateway.dart';

class TestDesktopGateway implements DesktopGateway {
  final files = StreamController<List<String>>.broadcast();
  List<String> selection = [];
  final Set<String> transferPaths = {};
  String? openedTemplate;

  @override
  Stream<List<String>> get droppedFiles => files.stream;
  @override
  Stream<String> get dropWarnings => const Stream.empty();
  @override
  Future<List<String>> chooseImages() async => selection;
  @override
  Future<String?> chooseDirectory() async => null;
  @override
  Future<String?> saveImageAs(String sourcePath, String suggestedName) async =>
      null;
  @override
  Future<bool> dragFile(String sourcePath) async => false;
  @override
  Future<void> openWebTemplate(String templateId) async {
    openedTemplate = templateId;
  }

  @override
  Future<List<String>> prepareDroppedFiles(List<String> paths) async => paths;
  @override
  Future<void> releaseDroppedFiles(List<String> paths) async {
    for (final path in paths) {
      if (transferPaths.contains(path)) await File(path).delete();
    }
  }

  @override
  Future<void> setAlwaysOnTop(bool enabled) async {}
  @override
  Future<void> dispose() => files.close();
}

void main() {
  testWidgets('录单导图和模板关联后，确认删除订单并保留原图', (tester) async {
    tester.view.physicalSize = const Size(1280, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final root = (await tester.runAsync(
      () => Directory.systemTemp.createTemp('pic-workbench-'),
    ))!;
    final repository = LocalOrderRepository(Directory('${root.path}/library'));
    final controller = OrderController(
      repository: repository,
      templates: initialTemplates,
    );
    final desktop = TestDesktopGateway();
    addTearDown(() async {
      controller.dispose();
      await desktop.dispose();
      await tester.runAsync(() => root.delete(recursive: true));
    });

    await tester.pumpWidget(
      MaterialApp(
        home: WorkbenchPage(
          controller: controller,
          desktop: desktop,
          storage: StorageSettings(repository.root),
        ),
      ),
    );
    // IO completion runs in real time; its fake-zone continuations need pumps.
    Future<void> settleIo() async {
      for (var attempt = 0; attempt < 200; attempt++) {
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 5)),
        );
        await tester.pump();
        if (!controller.busy) {
          await tester.pumpAndSettle();
          return;
        }
      }
      fail('订单操作未完成：${controller.error}');
    }

    await settleIo();
    await tester.enterText(find.byType(TextField), '001610');
    await tester.tap(find.text('打开／新建'));
    await settleIo();
    final source = await tester.runAsync(
      () => File('${root.path}/客户.png').writeAsBytes(
        base64Decode(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
        ),
      ),
    );
    desktop.selection = [source!.path];
    await tester.tap(find.text('导入图片'));
    await settleIo();
    expect(find.text('制作模板'), findsOneWidget);
    for (final label in ['缤纷糖果 · A5 竖版', '爱心＋星星混合款']) {
      await tester.ensureVisible(find.widgetWithText(FilterChip, label));
      await tester.tap(find.text(label));
      await settleIo();
    }
    final reopened = await tester.runAsync(
      () => repository.load(controller.current!.id),
    );
    expect(reopened!.images.single.templateIds, {'缤纷糖果.png', '模板混合.png'});
    expect(find.textContaining('2 份制作任务'), findsOneWidget);
    await tester.ensureVisible(find.text('去制作'));
    await tester.tap(find.text('去制作'));
    await tester.pumpAndSettle();
    await tester.tap(
      find.widgetWithText(PopupMenuItem<TemplateDefinition>, '缤纷糖果 · A5 竖版'),
    );
    await tester.pumpAndSettle();
    expect(desktop.openedTemplate, '缤纷糖果.png');

    // Emulate native virtual-file staging. Acknowledgement removes the transfer
    // copy; the committed original must remain readable and unassigned.
    final transfer = (await tester.runAsync(
      () => source.copy('${root.path}/拖入.png'),
    ))!;
    desktop.transferPaths.add(transfer.path);
    desktop.files.add([transfer.path]);
    await settleIo();
    final afterDrop = (await tester.runAsync(
      () => repository.load(controller.current!.id),
    ))!;
    expect(afterDrop.images, hasLength(2));
    expect(afterDrop.images.last.templateIds, isEmpty);
    final savedBytes = await tester.runAsync(
      () => File(
        repository.imagePath(afterDrop.id, afterDrop.images.last),
      ).readAsBytes(),
    );
    final sourceBytes = await tester.runAsync(source.readAsBytes);
    expect(savedBytes, sourceBytes);
    expect(await tester.runAsync(transfer.exists), isFalse);
    expect(await tester.runAsync(source.exists), isTrue);

    // Cancel keeps the active order; confirm removes it without deleting photos.
    await tester.tap(find.byTooltip('删除订单'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(controller.current!.id, afterDrop.id);
    await tester.tap(find.byTooltip('删除订单'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, '删除'));
    await settleIo();
    expect(controller.current, isNull);
    expect(controller.selectedImage, isNull);
    expect(controller.orders, isEmpty);
    expect(await tester.runAsync(repository.listOrders), isEmpty);
    final archived = (await tester.runAsync(
      () => Directory('${repository.root.path}/trash').list().toList(),
    ))!;
    expect(archived, hasLength(1));
    expect(
      await tester.runAsync(
        () => File('${archived.single.path}/order.json').exists(),
      ),
      isTrue,
    );
    for (final image in afterDrop.images) {
      expect(
        await tester.runAsync(
          () => File(repository.imagePath(afterDrop.id, image)).readAsBytes(),
        ),
        sourceBytes,
      );
    }
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
