import 'package:flutter/material.dart';

import 'app/app_dependencies.dart';
import 'app/order_materials_app.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(OrderMaterialsApp(dependencies: await AppDependencies.windows()));
}
