#!/usr/bin/env python3
"""
Batch-update formatMoney and formatAmount call sites to pass settings.currency.

For each file containing formatMoney( or formatAmount( calls:
1. If useApp is imported (from app-context), ensure settings is destructured
2. If useApp is NOT imported, add the import and a useApp call inside the component
3. Replace each formatMoney(x) -> formatMoney(x, settings.currency)
   (and formatAmount(x) -> formatAmount(x, settings.currency))
4. Skip any call that already has settings.currency or is in a context variable
"""
import ast, os, re, sys

RENDERER_DIR = "src/renderer"
changed = []


def find_component_function(tree):
    """Find the outermost function component (a function returning JSX)."""
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for child in ast.walk(node):
                if isinstance(child, ast.Return) and child.value is not None:
                    val = child.value
                    if isinstance(val, ast.Call) and isinstance(val.func, ast.Name):
                        if val.func.id in ('formatMoney', 'formatAmount'):
                            continue  # not a JSX return
                    if isinstance(val, ast.Call):
                        # Check for JSX element like <Element />
                        if isinstance(val.func, ast.Name) and val.func.id.startswith('createElement'):
                            pass
                if isinstance(child, ast.Name) and child.id in ('settings', 'settings'):
                    return node
    return None


class FormatCallVisitor(ast.NodeVisitor):
    def __init__(self):
        self.calls = []

    def visit_Call(self, node):
        if isinstance(node.func, ast.Attribute):
            if node.func.attr in ('formatMoney', 'formatAmount'):
                self.calls.append(node)
        self.generic_visit(node)


def needs_currency_arg(call_node):
    """Check if call already has settings.currency as an argument."""
    for arg in call_node.args:
        # check if any argument contains 'settings'
        for node in ast.walk(arg):
            if isinstance(node, ast.Attribute) and node.attr == 'currency':
                if isinstance(node.value, ast.Name) and node.value.id == 'settings':
                    return False
    for kw in call_node.keywords:
        if kw.arg == 'currency':
            return False
    # Check if the first positional argument is settings.something
    if call_node.args:
        first = call_node.args[0]
        for node in ast.walk(first):
            if isinstance(node, ast.Attribute) and node.attr == 'currency':
                if isinstance(node.value, ast.Name) and node.value.id == 'settings':
                    return False
    return True


def get_use_app_call(tree):
    """Find an existing useApp() call and what it destructures."""
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'useApp':
            if node.parent and isinstance(node.parent, ast.Assign):
                # Destructure assignment
                target = node.parent.targets[0]
                if isinstance(target, ast.Tuple):
                    names = [e.id for e in target.elts if isinstance(e, ast.Name)]
                    return names, node.parent.lineno
                elif isinstance(target, ast.Name):
                    return [target.id], node.parent.lineno
            elif node.parent and isinstance(node.parent, ast.AnnAssign):
                target = node.parent.target
                if isinstance(target, ast.Name):
                    return [target.id], node.parent.lineno
    return None, None


def process_file(fpath):
    global changed
    with open(fpath, 'r', encoding='utf-8') as f:
        source = f.read()

    try:
        tree = ast.parse(source)
    except SyntaxError:
        print(f"  SKIP (syntax error): {fpath}")
        return

    visitor = FormatCallVisitor()
    visitor.visit(tree)
    if not visitor.calls:
        return

    # Check if any calls need updating
    calls_to_update = [c for c in visitor.calls if needs_currency_arg(c)]
    if not calls_to_update:
        print(f"  SKIP (already updated): {fpath}")
        return

    # Build set of line ranges for calls to update
    update_lines = set()
    for call in calls_to_update:
        update_lines.add(call.lineno)

    lines = source.split('\n')

    # Check if useApp is available in scope
    uses_use_app = False
    has_use_app_import = False
    import_line_num = None

    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            if node.module and 'app-context' in node.module:
                for alias in node.names:
                    if alias.name == 'useApp':
                        uses_use_app = True
                        has_use_app_import = True
                        import_line_num = node.lineno
                        break

    # Find all useApp() calls in the file
    use_app_calls = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'useApp':
            use_app_calls.append(node)

    # Check if any useApp call already destructures settings
    has_settings = False
    for ua_node in use_app_calls:
        parent = getattr(ua_node, 'parent', None)
        # Walk up to find the assignment
        for n in ast.walk(tree):
            if isinstance(n, (ast.Assign,)) and any(isinstance(t, ast.Name) and t.id == 'settings' for t in n.targets if isinstance(t, ast.Name)):
                has_settings = True

    # Simpler check: does 'settings' appear as a name anywhere?
    has_settings_anywhere = False
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and node.id == 'settings':
            has_settings_anywhere = True
            break

    # Check if the file uses settings at all
    settings_usage_lines = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and node.attr == 'currency':
            if isinstance(node.value, ast.Name) and node.value.id == 'settings':
                settings_usage_lines.add(node.lineno)

    # Strategy: for each line containing a formatMoney/formatAmount call,
    # replace the call with the currency arg.
    # Then ensure settings is available (add useApp if needed).

    new_lines = lines[:]
    file_changed = False

    # Process lines in reverse to preserve line numbers
    for lineno in sorted(update_lines, reverse=True):
        idx = lineno - 1
        if idx >= len(new_lines):
            continue
        line = new_lines[idx]

        # Skip if already has settings.currency
        if 'settings.currency' in line:
            continue

        # Replace formatMoney(x) -> formatMoney(x, settings.currency)
        # and formatAmount(x) -> formatAmount(x, settings.currency)
        def replace_call(match):
            func = match.group(1)
            args = match.group(2)
            # Check if args already contains settings.currency
            if 'settings.currency' in args:
                return match.group(0)
            return f'{func}({args}, settings.currency)'

        # Pattern: formatMoney(...) or formatAmount(...)
        # Capture the function name and everything inside the outermost parens
        line = re.sub(r'\b(formatMoney|formatAmount)\(([^)]*(?:\([^)]*\)[^)]*)*)\)', replace_call, line)
        # Handle nested parens more carefully
        # Actually, let's use a more robust approach
        new_lines[idx] = line
        file_changed = True

    if not file_changed:
        return

    new_source = '\n'.join(new_lines)

    # Now ensure useApp import and settings availability
    if not has_use_app_import:
        # Add import
        # Find the last import in the file
        import_section_end = 0
        for node in tree.body:
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                import_section_end = node.end_lineno or node.lineno
            elif not isinstance(node, (ast.Import, ast.ImportFrom)):
                break

        new_source = new_source.split('\n')

        # Find an existing line importing from app-context or add a new one
        app_context_idx = None
        for i, ln in enumerate(new_source):
            if 'app-context' in ln:
                app_context_idx = i
                break

        if app_context_idx is not None:
            # Add useApp to existing import
            new_source[app_context_idx] = re.sub(
                r'import \{(.*?)\} from "\.\./lib/app-context"',
                lambda m: f'import {{{m.group(1).rstrip()}, useApp}} from "../lib/app-context"',
                new_source[app_context_idx]
            )
        else:
            # Calculate relative import path
            rel_depth = fpath.count('/') - fpath.count('/src/')
            rel_path = '../' * rel_depth + 'lib/app-context'
            # Insert after last import
            new_source.insert(import_section_end, f'import {{ useApp }} from "{rel_path}";')

        new_source = '\n'.join(new_source)

    # Now ensure settings is destructured from useApp
    # Check if there's a useApp call
    tree2 = ast.parse(new_source)
    has_settings_destruction = False
    for node in ast.walk(tree2):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'useApp':
            # Walk up to find parent assignment
            for n in ast.walk(tree2):
                if isinstance(n, ast.Assign) and isinstance(n.value, ast.Call) and isinstance(n.value.func, ast.Name) and n.value.func.id == 'useApp':
                    if isinstance(n.targets[0], ast.Tuple):
                        names = [e.id for e in n.targets[0].elts if isinstance(e, ast.Name)]
                        if 'settings' in names:
                            has_settings_destruction = True
                    elif isinstance(n.targets[0], ast.Name) and n.targets[0].id == 'settings':
                        # settings = useApp()  - unlikely
                        has_settings_destruction = True

    if not has_settings_destruction and not has_settings_anywhere:
        # Find all useApp calls and add settings to destructuring
        # or add a new useApp call if none exist
        new_source_lines = new_source.split('\n')

        # Find the first function component in the file
        # and add const { settings } = useApp(); at the top if no useApp call exists
        if not use_app_calls:
            # Find first function definition
            for i, ln in enumerate(new_source_lines):
                if re.match(r'^function\s+\w+|^export\s+function\s+\w+', ln) or re.match(r'^const\s+\w+\s*=\s*\(', ln):
                    # Check if next line has useApp
                    # Insert after the function opening
                    indent = len(ln) - len(ln.lstrip())
                    new_source_lines.insert(i + 1, f'{" " * (indent + 2)}const {{ settings }} = useApp();')
                    break
        else:
            # Add settings to existing useApp destructure
            for i, ln in enumerate(new_source_lines):
                if re.search(r'\{\s*([^}]*)\s*\}\s*=\s*useApp\(\)', ln):
                    match = re.search(r'\{\s*([^}]*)\s*\}\s*=\s*useApp\(\)', ln)
                    current_names = [n.strip() for n in match.group(1).split(',') if n.strip()]
                    if 'settings' not in current_names:
                        current_names.append('settings')
                        new_ln = re.sub(
                            r'\{\s*[^}]*\s*\}\s*=\s*useApp\(\)',
                            '{ ' + ', '.join(current_names) + ' } = useApp()',
                            ln
                        )
                        new_source_lines[i] = new_ln
                    break

        new_source = '\n'.join(new_source_lines)

    with open(fpath, 'w', encoding='utf-8') as f:
        f.write(new_source)

    print(f"  UPDATED: {fpath} ({len(calls_to_update)} calls)")
    changed.append({
        'file': fpath,
        'count': len(calls_to_update)
    })


for root, dirs, files in os.walk(RENDERER_DIR):
    for fname in sorted(files):
        if fname.endswith(('.ts', '.tsx')):
            fpath = os.path.join(root, fname)
            process_file(fpath)

print(f"\nTotal: {sum(c['count'] for c in changed)} calls updated across {len(changed)} files")
for c in sorted(changed, key=lambda x: x['file']):
    print(f"  {c['file']}: {c['count']}")
