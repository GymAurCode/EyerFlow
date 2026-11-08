/**
 * Sales invoices.
 *
 * Delegates to `DocumentListPage`: the invoice list and the purchase list are
 * the same table read from a different direction, and keeping one component is
 * what stops the two screens drifting apart as fields are added. Everything
 * that makes it "sales" - the title, the button, the routes, the permission
 * module - is derived here from the document kind.
 */

import { DocumentListPage } from "./DocumentListPage";

export function SalesListPage(): React.JSX.Element {
  return <DocumentListPage kind="invoice" />;
}
