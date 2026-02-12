const _DATE = new Date();
const _DATE_LONGER = new Date();
const _DATE_LONGER.setDate(_DATE_LONGER.getDate() - 3);
const cachedFromMs = Date.parse(_DATE.toISOString().substring(0, 10));
const unsanitized = Object.assign({}, {}, _DATE_LONGER.toISOString().slice(0, _DATE_LONGER.toISOString().lastIndexOf(':')) + 'Z');