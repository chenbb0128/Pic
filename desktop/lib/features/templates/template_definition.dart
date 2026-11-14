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

// Preserve associations created before the web catalog was connected.
String canonicalTemplateId(String id) => switch (id) {
  'A08' => '缤纷糖果.png',
  'A03' => '模板混合.png',
  _ => id,
};

const initialTemplates = webTemplates;
