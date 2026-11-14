import 'dart:io';

import '../features/orders/application/order_controller.dart';
import '../features/orders/data/local_order_repository.dart';
import '../features/settings/storage_settings.dart';
import '../features/templates/template_definition.dart';
import '../platform/desktop_gateway.dart';
import '../platform/windows_desktop_gateway.dart';

class AppDependencies {
  AppDependencies({
    required this.orders,
    required this.desktop,
    required this.dataPath,
    required this.storage,
  });

  static Future<AppDependencies> windows() async {
    if (!Platform.isWindows) throw UnsupportedError('当前版本仅支持 Windows');
    final local = Platform.environment['LOCALAPPDATA'];
    if (local == null || local.isEmpty) throw StateError('无法确定 Windows 本地数据目录');
    final root = Directory('$local/Xiaoxingtie/OrderMaterials');
    final storage = StorageSettings(root);
    await storage.load();
    return AppDependencies(
      orders: OrderController(
        repository: LocalOrderRepository(
          root,
          imageRoot: () => storage.imageRoot,
        ),
        templates: webTemplates,
      ),
      desktop: WindowsDesktopGateway(
        diagnosticsDirectory: Directory('${root.path}/diagnostics'),
      ),
      dataPath: root.path,
      storage: storage,
    );
  }

  final OrderController orders;
  final DesktopGateway desktop;
  final String dataPath;
  final StorageSettings storage;
}
