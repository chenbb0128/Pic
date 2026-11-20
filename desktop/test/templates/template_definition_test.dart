import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pic_order_desktop/features/templates/template_definition.dart';

void main() {
  test('商品 A01–A12 按编号显示并打开对应 web 模板，兼容原有文件 ID', () {
    const expected = [
      ('A01', 'A01 爱心款', '模板爱心.png'),
      ('A02', 'A02 爱心横版', '爱心横版.png'),
      ('A03', 'A03 爱心+星星混合版', '模板混合.png'),
      ('A04', 'A04 粉色款', '模板粉色.png'),
      ('A05', 'A05 蓝色款', '模板蓝色.png'),
      ('A06', 'A06 黄色款', '模板黄色.png'),
      ('A07', 'A07 混合竖版', '甜心派对.png'),
      ('A08', 'A08 缤纷糖果版', '缤纷糖果.png'),
      ('A09', 'A09 大头混合横版', 'I-ME横版大头.png'),
      ('A10', 'A10 心动马卡龙款', '爱心心动马卡龙.png'),
      ('A11', 'A11 焦糖秋枫混合豹纹', '经典豹纹混合.png'),
      ('A12', 'A12 奶油黑粉混合豹纹', '黑粉奶油混合豹纹.png'),
    ];
    for (var i = 0; i < expected.length; i++) {
      final (code, label, webId) = expected[i];
      final template = initialTemplates[i];
      expect(template.name, label);
      expect(template.matches(code), isTrue, reason: code);
      expect(template.matches(webId), isTrue, reason: webId);
      expect(canonicalTemplateId(code), webId);
      expect(Uri.parse(template.webUrl).queryParameters['template'], webId);
    }
    expect(
      initialTemplates.map((template) => template.id).toSet(),
      webTemplates.map((template) => template.id).toSet(),
    );
    expect(initialTemplates, hasLength(17));
  });

  test('桌面端模板清单与 web 爱心星星工具一致，并兼容旧模板编号', () {
    expect(webTemplates, hasLength(17));
    expect(
      webTemplates.map((template) => template.webValue),
      containsAll([
        '模板爱心.png',
        '爱心横版.png',
        'I-ME横版大头.png',
        '爱心心动马卡龙.png',
        '甜心派对.png',
        '缤纷糖果.png',
        '草莓.png',
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
