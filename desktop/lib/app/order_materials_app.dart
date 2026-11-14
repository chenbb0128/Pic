import 'dart:async';

import 'package:flutter/material.dart';

import '../features/orders/presentation/workbench_page.dart';
import 'app_dependencies.dart';

class OrderMaterialsApp extends StatefulWidget {
  const OrderMaterialsApp({super.key, required this.dependencies});
  final AppDependencies dependencies;

  @override
  State<OrderMaterialsApp> createState() => _OrderMaterialsAppState();
}

class _OrderMaterialsAppState extends State<OrderMaterialsApp> {
  @override
  void dispose() {
    widget.dependencies.orders.dispose();
    unawaited(widget.dependencies.desktop.dispose());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: '订单素材台',
    debugShowCheckedModeBanner: false,
    theme: ThemeData(
      colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF5B5BD6)),
      useMaterial3: true,
      fontFamily: 'Microsoft YaHei',
      scaffoldBackgroundColor: const Color(0xFFF6F7FA),
      appBarTheme: const AppBarTheme(
        backgroundColor: Colors.white,
        surfaceTintColor: Colors.transparent,
        toolbarHeight: 56,
        titleTextStyle: TextStyle(
          fontFamily: 'Microsoft YaHei',
          fontSize: 18,
          fontWeight: FontWeight.w600,
          color: Color(0xFF202334),
        ),
      ),
    ),
    home: WorkbenchPage(
      controller: widget.dependencies.orders,
      desktop: widget.dependencies.desktop,
      storage: widget.dependencies.storage,
    ),
  );
}
