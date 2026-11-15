part 'web_templates.g.dart';

class TemplateDefinition {
  const TemplateDefinition({required this.id, required this.name});

  final String id;
  final String name;

  String get webValue => id;
  String get webUrl => Uri.https('pic.pdurl.cn', '/tools/heart-star', {
    'template': id,
  }).toString();

  bool matches(String value) => canonicalTemplateId(value) == id;
}

// Product codes are aliases; persisted IDs and web links keep using web IDs.
const productTemplates = <String, TemplateDefinition>{
  'A01': TemplateDefinition(id: '模板爱心.png', name: 'A01 爱心款'),
  'A02': TemplateDefinition(id: '爱心横版.png', name: 'A02 爱心横版'),
  'A03': TemplateDefinition(id: '模板混合.png', name: 'A03 爱心+星星混合版'),
  'A04': TemplateDefinition(id: '模板粉色.png', name: 'A04 粉色款'),
  'A05': TemplateDefinition(id: '模板蓝色.png', name: 'A05 蓝色款'),
  'A06': TemplateDefinition(id: '模板黄色.png', name: 'A06 黄色款'),
  'A07': TemplateDefinition(id: '甜心派对.png', name: 'A07 混合竖版'),
  'A08': TemplateDefinition(id: '缤纷糖果.png', name: 'A08 缤纷糖果版'),
  'A09': TemplateDefinition(id: 'I-ME横版大头.png', name: 'A09 大头混合横版'),
  'A10': TemplateDefinition(id: '爱心心动马卡龙.png', name: 'A10 心动马卡龙款'),
  'A11': TemplateDefinition(id: '经典豹纹混合.png', name: 'A11 焦糖秋枫混合豹纹'),
  'A12': TemplateDefinition(id: '黑粉奶油混合豹纹.png', name: 'A12 奶油黑粉混合豹纹'),
};

String canonicalTemplateId(String id) => productTemplates[id]?.id ?? id;

final initialTemplates = List<TemplateDefinition>.unmodifiable([
  ...productTemplates.values,
  ...webTemplates.where(
    (template) =>
        !productTemplates.values.any((product) => product.id == template.id),
  ),
]);
