import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pic_order_desktop/features/templates/template_definition.dart';

void main() {
  test('桌面端模板清单与 web 爱心星星工具一致，并兼容旧模板编号', () {
    expect(webTemplates, hasLength(16));
    expect(
      webTemplates.map((template) => template.webValue),
      containsAll([
        '模板爱心.png',
        '爱心横版.png',
        'I-ME横版大头.png',
        '爱心心动马卡龙.png',
        '甜心派对.png',
        '缤纷糖果.png',
        '模板混合.png',
        '经典豹纹混合.png',
        '黑粉奶油混合豹纹.png',
        '模板粉色.png',
        '模板蓝色.png',
        '模板黄色.png',
        '豹纹星星.png',
        '波点爱心.png',
        '波点圆形.png',
        '文案模板.png',
      ]),
    );
    final candy = webTemplates.firstWhere(
      (template) => template.webValue == '缤纷糖果.png',
    );
    final mixed = webTemplates.firstWhere(
      (template) => template.webValue == '模板混合.png',
    );
    expect(candy.matches('A08'), isTrue);
    expect(mixed.matches('A03'), isTrue);
    expect(
      candy.webUrl,
      contains('template=%E7%BC%A4%E7%BA%B7%E7%B3%96%E6%9E%9C.png'),
    );
    final html = File(
      '../web/public/embedded/heart-star/index.html',
    ).readAsStringSync();
    final select = RegExp(
      r'<select\b[^>]*\bid="template"[^>]*>(.*?)</select>',
      dotAll: true,
    ).firstMatch(html)!.group(1)!;
    final entries = RegExp(r'<option value="([^"]+)">([^<]+)</option>')
        .allMatches(select)
        .where((entry) => entry.group(1) != '自定义排版.png')
        .toList();
    expect(
      webTemplates.map((template) => (template.id, template.name)),
      entries.map((entry) => (entry.group(1), entry.group(2))),
    );
  });
}
