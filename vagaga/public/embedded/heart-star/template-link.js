(function (scope) {
  // Apply a desktop deep link once, before the editor loads its first template.
  function selectInitial(select, templates, search) {
    const name = new URLSearchParams(search).get('template');
    if (!name || !Object.hasOwn(templates, name) ||
        !Array.from(select.options).some(option => option.value === name)) return false;
    select.value = name;
    return true;
  }
  scope.HeartStarTemplateLink = { selectInitial };
})(globalThis);
