import 'dart:async';
import 'dart:io';

import 'package:flutter/services.dart' show rootBundle;

import '../features/orders/application/order_controller.dart';
import '../features/orders/application/vagaga_cdp_injector.dart';
import '../features/orders/application/vagaga_ingest_service.dart';
import '../features/orders/data/local_order_repository.dart';
import '../features/settings/storage_settings.dart';
import '../features/templates/template_definition.dart';
import '../platform/desktop_gateway.dart';
import '../platform/windows_desktop_gateway.dart';

class AppDependencies {
  AppDependencies({
    required this.orders,
    required this.desktop,
    required this.paidan,
    required this.paidanCdp,
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
    final orders = OrderController(
      repository: LocalOrderRepository(
        root,
        imageRoot: () => storage.imageRoot,
      ),
      templates: initialTemplates,
    );
    final deps = AppDependencies(
      orders: orders,
      desktop: WindowsDesktopGateway(
        diagnosticsDirectory: Directory('${root.path}/diagnostics'),
      ),
      paidan: PaidanIngestService(orders, Directory('${root.path}/inbox')),
      paidanCdp: PaidanCdpInjector(
        orders,
        coreScript: await rootBundle.loadString('assets/vagaga_capture.js'),
        incomingDirectory: Directory('${root.path}/incoming'),
      ),
      dataPath: root.path,
      storage: storage,
    );
    // 两条入库路径（收件箱投递 / CDP 直连）的事件统一对外。
    deps.paidan.events.listen(deps.addPaidanEvent);
    deps.paidanCdp.events.listen(deps.addPaidanEvent);
    return deps;
  }

  final OrderController orders;
  final DesktopGateway desktop;
  final PaidanIngestService paidan;
  final PaidanCdpInjector paidanCdp;
  final String dataPath;
  final StorageSettings storage;

  final _paidanHub = StreamController<PaidanIngestEvent>.broadcast();

  /// 收件箱与 CDP 直连的合并入库事件，供界面提示。
  Stream<PaidanIngestEvent> get paidanEvents => _paidanHub.stream;

  void addPaidanEvent(PaidanIngestEvent event) {
    if (!_paidanHub.isClosed) _paidanHub.add(event);
  }
}
