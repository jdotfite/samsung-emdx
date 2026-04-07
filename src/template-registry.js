import { musicEditorialTemplate } from "./templates/music-editorial.js";
import { musicMinimalTemplate } from "./templates/music-minimal.js";

export const TEMPLATE_REGISTRY = [musicEditorialTemplate, musicMinimalTemplate];

export function getTemplateById(templateId) {
  return TEMPLATE_REGISTRY.find((template) => template.id === templateId);
}
