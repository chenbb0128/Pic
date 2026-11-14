import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pic_order_desktop/platform/windows_desktop_gateway.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = 'cn.xiaoxingtie/order_materials/desktop';
  const codec = StandardMethodCodec();

  Future<void> nativeCall(String method, Object? arguments) async {
    final done = Completer<void>();
    await TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .handlePlatformMessage(
          channel,
          codec.encodeMethodCall(MethodCall(method, arguments)),
          (_) => done.complete(),
        );
    await done.future;
  }

  test('拖拽诊断保存格式元数据，拒绝时提示已记录，不声称是虚拟文件', () async {
    final root = await Directory.systemTemp.createTemp('pic-drag-formats-');
    final gateway = WindowsDesktopGateway(diagnosticsDirectory: root);
    addTearDown(() async {
      await gateway.dispose();
      await root.delete(recursive: true);
    });
    final warning = gateway.dropWarnings.first;
    await nativeCall('dragFormats', {
      'formats': [
        {'id': 49161, 'name': 'HTML Format', 'tymed': 1, 'index': -1},
        {
          'id': 49162,
          'name': 'UniformResourceLocatorW',
          'tymed': 1,
          'index': -1,
        },
      ],
      'fileQueryResult': -2147221399,
      'allowedEffects': 1,
    });
    await nativeCall('unsupportedDrop', null);
    final recorded =
        jsonDecode(await File('${root.path}/last_drag.json').readAsString())
            as Map<String, dynamic>;
    expect(
      (recorded['formats'] as List<dynamic>).map(
        (format) => (format as Map<String, dynamic>)['name'],
      ),
      ['HTML Format', 'UniformResourceLocatorW'],
    );
    expect(recorded.containsKey('imageBytes'), isFalse);
    expect(await warning, contains('已记录'));
    expect(await File('${root.path}/last_drag.json').exists(), isTrue);
  });

  test('普通文件拖入仍交给原有图片导入流程', () async {
    final root = await Directory.systemTemp.createTemp('pic-drag-files-');
    final gateway = WindowsDesktopGateway(diagnosticsDirectory: root);
    addTearDown(() async {
      await gateway.dispose();
      await root.delete(recursive: true);
    });
    final files = gateway.droppedFiles.first;
    await nativeCall('filesDropped', ['C:\\images\\a.png']);
    expect(await files, ['C:\\images\\a.png']);
  });
}
