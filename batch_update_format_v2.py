#!/usr/bin/env python3
"""
Simple string replacement for formatMoney/formatAmount calls.
"""
import os, re

RENDERER_DIR = "src/renderer"

files_to_update = [
    "components/documents/DocumentEditor.tsx",
    "components/print/document-templates.ts",
    "components/documents/DocumentViewDialog.tsx",
    "lib/hooks.ts",
    "pages/finance/ExpensesPage.tsx",
    "pages/ReportsPage.tsx",
    "pages/sales/DocumentListPage.tsx",
    "pages/sales/SalesEditorPage.tsx",
    "pages/sales/DocumentDetailPage.tsx",
    "pages/parties/PartiesPage.tsx",
    "pages/inventory/ProductsPage.tsx",
]

def process_file(fpath):
    with open(fpath, 'r', encoding='utf-8') as f:
        source = f.read()

    # Check if formatMoney/formatAmount is imported
    has_import = 'formatMoney' in source or 'formatAmount' in source
    if not has_import:
        return False

    # Replace formatMoney(x) -> formatMoney(x, settings.currency)
    # And formatAmount(x) -> formatAmount(x, settings.currency)
    # But skip if already has settings.currency
    lines = source.split('\n')
    changed = False
    new_lines = []

    for line in lines:
        # Skip if already has settings.currency
        if 'settings.currency' in line:
            new_lines.append(line)
            continue

        # Skip if it's the import line
        if 'import' in line and ('formatMoney' in line or 'formatAmount' in line):
            new_lines.append(line)
            continue

        # Skip function definitions
        if 'export function formatMoney' in line or 'export function formatAmount' in line:
            new_lines.append(line)
            continue

        # Replace formatMoney(x) -> formatMoney(x, settings.currency)
        # Using a more careful regex
        def replace_func(match):
            func = match.group(1)
            args = match.group(2)
            if 'settings.currency' in args:
                return match.group(0)
            return f'{func}({args}, settings.currency)'

        # Match formatMoney(...) or formatAmount(...) - non-greedy match
        # But handle nested parens
        new_line = line
        # Simple approach: match formatMoney(...) and add currency
        # We'll do multiple passes

        # Find all formatMoney(...) calls
        for func_name in ['formatMoney', 'formatAmount']:
            # Pattern to match function calls with balanced parens
            # Use a while loop to find each call
            while True:
                idx = new_line.find(func_name + '(')
                if idx == -1:
                    break
                # Find matching closing paren
                depth = 0
                start = idx
                end = -1
                for i in range(idx + len(func_name), len(new_line)):
                    if new_line[i] == '(':
                        depth += 1
                    elif new_line[i] == ')':
                        depth -= 1
                        if depth == 0:
                            end = i
                            break
                if end == -1:
                    break
                call_text = new_line[start:end+1]
                if 'settings.currency' in call_text:
                    # Move past this call
                    new_line = new_line[:start] + call_text + '|DONE|' + new_line[end+1:]
                    continue
                # Replace
                new_call = call_text.rstrip(')') + ', settings.currency)'
                new_line = new_line[:start] + new_call + new_line[end+1:]
                changed = True
            new_line = new_line.replace('|DONE|', '')

        new_lines.append(new_line)

    if changed:
        with open(fpath, 'w', encoding='utf-8') as f:
            f.write('\n'.join(new_lines))
        return True
    return False

for fname in files_to_update:
    fpath = os.path.join(RENDERER_DIR, fname)
    if os.path.exists(fpath):
        if process_file(fpath):
            print(f"UPDATED: {fpath}")
        else:
            print(f"No changes: {fpath}")
    else:
        print(f"NOT FOUND: {fpath}")