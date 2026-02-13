export interface HeroBlock {
  type: "hero";
  label?: string;
  collapsed?: boolean;
  title: string;
  subtitle?: string;
  accent?: string;
}

export interface CardItem {
  title: string;
  body: string;
  icon?: string;
  link?: string;
}

export interface CardsBlock {
  type: "cards";
  label?: string;
  collapsed?: boolean;
  items: CardItem[];
}

export interface KeyValueItem {
  key: string;
  value: string;
}

export interface KeyValueBlock {
  type: "key-value";
  label?: string;
  collapsed?: boolean;
  items: KeyValueItem[];
}

export interface TableBlock {
  type: "table";
  label?: string;
  collapsed?: boolean;
  headers: string[];
  rows: string[][];
}

export interface ListItem {
  text: string;
  checked?: boolean;
}

export interface ListBlock {
  type: "list";
  label?: string;
  collapsed?: boolean;
  ordered?: boolean;
  checkbox?: boolean;
  items: ListItem[];
}

export interface MarkdownBlock {
  type: "markdown";
  label?: string;
  collapsed?: boolean;
  content: string;
}

export interface HtmlBlock {
  type: "html";
  label?: string;
  collapsed?: boolean;
  content: string;
}

export type Block =
  | HeroBlock
  | CardsBlock
  | KeyValueBlock
  | TableBlock
  | ListBlock
  | MarkdownBlock
  | HtmlBlock;

export interface Page {
  id: string;
  title: string;
  subtitle?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  blocks: Block[];
}
