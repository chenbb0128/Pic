import 'package:flutter/material.dart';

import '../../application/order_controller.dart';
import '../../domain/order_document.dart';

class OrderList extends StatelessWidget {
  const OrderList({
    super.key,
    required this.controller,
    required this.onDelete,
    this.enabled = true,
  });
  final OrderController controller;
  final ValueChanged<OrderDocument> onDelete;
  final bool enabled;

  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(12),
    children: [
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        child: Row(
          children: [
            Text('订单', style: Theme.of(context).textTheme.titleSmall),
            const Spacer(),
            Text(
              '${controller.orders.length}',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ),
      ),
      const SizedBox(height: 8),
      for (final order in controller.orders)
        Card(
          elevation: 0,
          margin: const EdgeInsets.only(bottom: 8),
          color: controller.current?.id == order.id
              ? Theme.of(context).colorScheme.secondaryContainer
              : Colors.white,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(10),
          ),
          child: ListTile(
            enabled: enabled && !controller.busy,
            contentPadding: const EdgeInsets.symmetric(
              horizontal: 12,
              vertical: 2,
            ),
            title: Tooltip(
              message: order.orderNumber,
              child: Text(
                order.orderNumber,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            subtitle: Text(
              '${order.images.length} 张图片${order.unassignedCount > 0 ? ' · ${order.unassignedCount} 待分配' : ''}',
              style: Theme.of(context).textTheme.bodySmall,
            ),
            trailing: IconButton(
              tooltip: '删除订单',
              icon: const Icon(Icons.delete_outline, size: 18),
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints.tightFor(width: 28, height: 32),
              onPressed: enabled && !controller.busy
                  ? () => onDelete(order)
                  : null,
            ),
            onTap: enabled && !controller.busy
                ? () => controller.openOrder(order.id)
                : null,
          ),
        ),
    ],
  );
}
