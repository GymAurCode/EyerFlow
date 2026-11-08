/**
 * Record actions.
 *
 * The same four things can be done to a record almost everywhere in the app:
 * look at it, change it, delete it, print it. The order and the wording are
 * the same in every list, so they are defined once here rather than rebuilt
 * on each page.
 */

import type { ReactNode } from "react";
import { Eye, Pencil, Printer, Trash2 } from "lucide-react";
import { RowActions, type MenuItem } from "./Dropdown";

/** One action in a record's menu. */
export interface RecordAction {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode | undefined;
  readonly destructive?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly onSelect: () => void;
}

/**
 * The row action menu.
 *
 * The wrapper stops the click from reaching the row, so opening the menu does
 * not also open the record - which is what happens on a table where the whole
 * row is clickable.
 */
export function RecordActions({
  items,
}: {
  readonly items: readonly RecordAction[];
}): React.JSX.Element {
  if (items.length === 0) {
    return <span className="text-[var(--text-3)]">—</span>;
  }

  const menuItems: MenuItem[] = items.map((item) => ({
    id: item.id,
    label: item.label,
    ...(item.icon !== undefined ? { icon: item.icon } : {}),
    ...(item.destructive === true ? { destructive: true } : {}),
    ...(item.disabled === true ? { disabled: true } : {}),
    onSelect: item.onSelect,
  }));

  return (
    <div
      onClick={(event) => {
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
      }}
    >
      <RowActions items={menuItems} />
    </div>
  );
}

export interface StandardRecordActions {
  readonly canView?: boolean | undefined;
  readonly canEdit?: boolean | undefined;
  readonly canDelete?: boolean | undefined;
  readonly canPrint?: boolean | undefined;
  readonly onView?: (() => void) | undefined;
  readonly onEdit?: (() => void) | undefined;
  readonly onDelete?: (() => void) | undefined;
  readonly onPrint?: (() => void) | undefined;
}

/**
 * The standard set of record actions.
 *
 * An action that is not available is left out rather than shown greyed out:
 * a menu full of things the signed-in user cannot do is noise.
 */
export function standardRecordActions(options: StandardRecordActions): RecordAction[] {
  const actions: RecordAction[] = [];

  if (options.canView === true && options.onView !== undefined) {
    actions.push({
      id: "view",
      label: "View",
      icon: <Eye className="h-4 w-4" />,
      onSelect: options.onView,
    });
  }

  if (options.canEdit === true && options.onEdit !== undefined) {
    actions.push({
      id: "edit",
      label: "Edit",
      icon: <Pencil className="h-4 w-4" />,
      onSelect: options.onEdit,
    });
  }

  if (options.canPrint === true && options.onPrint !== undefined) {
    actions.push({
      id: "print",
      label: "Print",
      icon: <Printer className="h-4 w-4" />,
      onSelect: options.onPrint,
    });
  }

  if (options.canDelete === true && options.onDelete !== undefined) {
    actions.push({
      id: "delete",
      label: "Delete",
      icon: <Trash2 className="h-4 w-4" />,
      destructive: true,
      onSelect: options.onDelete,
    });
  }

  return actions;
}
