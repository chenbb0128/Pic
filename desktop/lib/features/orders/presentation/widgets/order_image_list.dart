import 'dart:io';

import 'package:flutter/material.dart';

import '../../../../platform/desktop_gateway.dart';
import '../../application/order_controller.dart';
import 'file_drag_source.dart';

class OrderImageList extends StatelessWidget {
  const OrderImageList({
    super.key,
    required this.controller,
    required this.desktop,
  });
  final OrderController controller;
  final DesktopGateway desktop;

  @override
  Widget build(BuildContext context) => ListView.builder(
    padding: const EdgeInsets.all(10),
    itemCount: controller.current!.images.length,
    itemBuilder: (context, index) {
      final image = controller.current!.images[index];
      final selected = controller.selectedImage?.id == image.id;
      return Card(
        margin: const EdgeInsets.only(bottom: 10),
        elevation: 0,
        clipBehavior: Clip.antiAlias,
        color: selected
            ? Theme.of(context).colorScheme.secondaryContainer
            : Colors.white,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(10),
          side: BorderSide(
            color: selected
                ? Theme.of(context).colorScheme.primary
                : const Color(0xFFE7E9F0),
          ),
        ),
        child: InkWell(
          onTap: controller.busy
              ? null
              : () => controller.selectImage(image.id),
          child: Padding(
            padding: const EdgeInsets.all(10),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                FileDragSource(
                  key: ValueKey(image.id),
                  path: controller.imagePath(image),
                  desktop: desktop,
                  enabled: !controller.busy,
                  onError: controller.reportError,
                  child: Image.file(
                    File(controller.imagePath(image)),
                    height: 95,
                    fit: BoxFit.contain,
                    cacheWidth: 220,
                    errorBuilder: (_, _, _) => const SizedBox(
                      height: 95,
                      child: Icon(Icons.broken_image_outlined),
                    ),
                  ),
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    Text(
                      '${index + 1}',
                      style: Theme.of(context).textTheme.labelMedium,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        image.templateIds.isEmpty
                            ? '待分配'
                            : image.templateIds
                                  .map(controller.templateName)
                                  .join('、'),
                        textAlign: TextAlign.right,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.labelSmall,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      );
    },
  );
}
