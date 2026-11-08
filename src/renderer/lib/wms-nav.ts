import {
  Warehouse,
  LayoutDashboard,
  MapPin,
  PackageCheck,
  ScanLine,
  ArrowRightLeft,
  ClipboardCheck,
} from "lucide-react";
import type { NavSection } from "./ims-nav";
export const WMS_ICON = Warehouse;
export const WMS_SECTIONS: readonly NavSection[] = [
  {
    id: "wms-overview",
    icon: LayoutDashboard,
    label: "Overview",
    items: [
      {
        label: "Warehouse Dashboard",
        path: "/wms/overview",
        icon: LayoutDashboard,
        module: "warehouse",
      },
    ],
  },
  {
    id: "wms-setup",
    icon: Warehouse,
    label: "Warehouse Setup",
    items: [
      { label: "Warehouses", path: "/wms/warehouses", icon: Warehouse, module: "warehouse" },
      { label: "Zones & Bins", path: "/wms/bins", icon: MapPin, module: "warehouse" },
      { label: "Dock Doors", path: "/wms/docks", icon: MapPin, module: "warehouse" },
    ],
  },
  {
    id: "wms-inbound",
    icon: PackageCheck,
    label: "Inbound Operations",
    items: [
      {
        label: "Inbound Appointments",
        path: "/wms/appointments",
        icon: PackageCheck,
        module: "warehouse",
      },
      {
        label: "Inbound References / ASN",
        path: "/wms/inbounds",
        icon: PackageCheck,
        module: "warehouse",
      },
      { label: "Goods Receiving", path: "/wms/receiving", icon: ScanLine, module: "warehouse" },
      {
        label: "Directed Putaway",
        path: "/wms/putaway",
        icon: ArrowRightLeft,
        module: "warehouse",
      },
    ],
  },
  {
    id: "wms-stock",
    icon: MapPin,
    label: "Stock & Storage",
    items: [
      { label: "Stock Locator", path: "/wms/stock-locator", icon: MapPin, module: "warehouse" },
      {
        label: "Internal Transfers",
        path: "/wms/transfers",
        icon: ArrowRightLeft,
        module: "warehouse",
      },
      {
        label: "Pick-Face Replenishment",
        path: "/wms/replenishment",
        icon: ArrowRightLeft,
        module: "warehouse",
      },
      {
        label: "Stock Reconciliation",
        path: "/wms/reconciliation",
        icon: ClipboardCheck,
        module: "warehouse",
      },
    ],
  },
  {
    id: "wms-outbound",
    icon: PackageCheck,
    label: "Outbound Operations",
    items: [
      {
        label: "Dispatch Requests",
        path: "/wms/dispatch-requests",
        icon: PackageCheck,
        module: "warehouse",
      },
      { label: "Picking Tasks", path: "/wms/picking", icon: ScanLine, module: "warehouse" },
      { label: "Packing & Cartons", path: "/wms/packing", icon: PackageCheck, module: "warehouse" },
      { label: "Shipment Staging", path: "/wms/staging", icon: MapPin, module: "warehouse" },
      {
        label: "Loading & Dispatch",
        path: "/wms/dispatch",
        icon: ArrowRightLeft,
        module: "warehouse",
      },
    ],
  },
  {
    id: "wms-workforce",
    icon: ClipboardCheck,
    label: "Workforce",
    items: [
      { label: "Warehouse Tasks", path: "/wms/tasks", icon: ClipboardCheck, module: "warehouse" },
    ],
  },
  {
    id: "wms-control",
    icon: ClipboardCheck,
    label: "Inventory Control",
    items: [
      { label: "Cycle Counts", path: "/wms/counts", icon: ClipboardCheck, module: "warehouse" },
      { label: "Returns Receiving", path: "/wms/returns", icon: PackageCheck, module: "warehouse" },
    ],
  },
  {
    id: "wms-analytics",
    icon: ClipboardCheck,
    label: "Analytics & Configuration",
    items: [
      {
        label: "Warehouse Reports",
        path: "/wms/reports",
        icon: ClipboardCheck,
        module: "warehouse",
      },
      { label: "WMS Settings", path: "/wms/settings", icon: ClipboardCheck, module: "warehouse" },
    ],
  },
];
