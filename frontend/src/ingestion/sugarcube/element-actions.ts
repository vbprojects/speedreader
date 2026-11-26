/** Trusted application extensions translate inert story markup into native reader actions. */
export type ElementAction =
  | { kind: "continue"; label: string; target: string; setter?: string }
  | { kind: "text-input"; label: string; variable: string; defaultValue?: string; target?: string };

type ElementActionFactory = (element: Element) => ElementAction;
const factories = new Map<string, ElementActionFactory>();

export function registerStoryElement(tag: string, factory: ElementActionFactory): () => void {
  if (!/^[a-z][a-z0-9.-]*-[a-z0-9.-]+$/.test(tag) || factories.has(tag)) {
    throw new Error("Invalid or duplicate story element: " + tag);
  }
  factories.set(tag, factory);
  return () => { if (factories.get(tag) === factory) factories.delete(tag); };
}

export function elementAction(markup: string): ElementAction {
  const template = document.createElement("template");
  template.innerHTML = markup;
  const element = template.content.firstElementChild;
  if (!element) throw new Error("Invalid story element.");
  const factory = factories.get(element.localName);
  if (factory) return factory(element);
  const target = element.getAttribute("data-passage");
  if (!target) throw new Error("Custom action <" + element.localName + "> requires data-passage or a registered handler.");
  return { kind: "continue", target, label: element.getAttribute("aria-label") || element.textContent?.trim() || element.localName };
}
