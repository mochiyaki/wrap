import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// --- Types --------------------------------------------------------------------

/** A flat map of label -> command string or prompt string. */
type WrapperEntry = { [label: string]: string };

/** Top-level wrapper.json shape: array of category objects. */
type WrapperConfig = Array<{
    useWsl?: string[];
    [category: string]: WrapperEntry[] | string[] | undefined;
}>;

// --- State --------------------------------------------------------------------

let statusBarItem: vscode.StatusBarItem;

/**
 * Single shared terminal reused across Command executions and Content sends.
 * When a Command is run it lands here so Content items can pipe into it.
 */
let sharedTerminal: vscode.Terminal | undefined;


// --- Activation ---------------------------------------------------------------

export function activate(context: vscode.ExtensionContext) {
    // Status-bar button - bottom-right, higher priority shows it further right
    statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    statusBarItem.command = 'wrapper.showMenu';
    statusBarItem.text = '$(layers) Wrapper';
    statusBarItem.tooltip = 'Click to open Wrapper menu';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Main command
    context.subscriptions.push(
        vscode.commands.registerCommand('wrapper.showMenu', () =>
            showRootMenu(context)
        )
    );

    // Clean up reference when the user closes the shared terminal
    context.subscriptions.push(
        vscode.window.onDidCloseTerminal(closed => {
            if (sharedTerminal && closed === sharedTerminal) {
                sharedTerminal = undefined;
            }
        })
    );
}

export function deactivate() {
    sharedTerminal?.dispose();
}

// --- Config loading -----------------------------------------------------------

function loadConfig(context: vscode.ExtensionContext): WrapperConfig | undefined {
    const settings = vscode.workspace.getConfiguration('wrapper');
    const customPath = settings.get<string>('configPath', '');

    const candidates: string[] = [];

    if (customPath) {
        candidates.push(customPath);
    }

    // Workspace root
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
        candidates.push(path.join(folders[0].uri.fsPath, 'wrapper.json'));
    }

    // Extension bundle (fallback)
    candidates.push(path.join(context.extensionPath, 'wrapper.json'));

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            try {
                const raw = fs.readFileSync(candidate, 'utf8');
                return JSON.parse(raw) as WrapperConfig;
            } catch (err) {
                vscode.window.showErrorMessage(
                    `Wrapper: failed to parse ${candidate}: ${err}`
                );
                return undefined;
            }
        }
    }

    vscode.window.showErrorMessage(
        'Wrapper: wrapper.json not found. ' +
        'Place it in the workspace root or set wrapper.configPath.'
    );
    return undefined;
}

// --- Menu rendering -----------------------------------------------------------

/**
 * Show a bottom-right toast-style picker using VS Code notifications.
 * Returns the selected label or undefined if dismissed.
 */
async function pickFromNotification(
    title: string,
    items: Array<{ label: string; detail?: string }>
): Promise<string | undefined> {
    if (items.length === 0) { return undefined; }

    const listText = items
        .slice(0, 6)
        // Keep the notification concise: show only the primary label, not the
        // full command/content string.
        .map(item => `-  ${item.label}`)
        .join('\n');
    const overflow = items.length > 6
        ? `\n...and ${items.length - 6} more`
        : '';

    const message = `${title}\n${listText}${overflow}`;
    return vscode.window.showInformationMessage(message, ...items.map(i => i.label));
}

async function showRootMenu(context: vscode.ExtensionContext) {
    const config = loadConfig(context);
    if (!config || config.length === 0) { return; }

    // Collect useWsl labels from all blocks
    const useWslLabels: string[] = [];
    for (const block of config) {
        if (Array.isArray(block.useWsl)) {
            useWslLabels.push(...block.useWsl);
        }
    }

    // Merge all top-level category keys from every entry in the array
    const categoryMap: { [cat: string]: WrapperEntry[] } = {};
    for (const block of config) {
        for (const [cat, entries] of Object.entries(block)) {
            if (cat === 'useWsl') { continue; }
            if (!categoryMap[cat]) { categoryMap[cat] = []; }
            categoryMap[cat].push(...(entries as WrapperEntry[]));
        }
    }

    const categories = Object.keys(categoryMap);
    if (categories.length === 0) { return; }

    // Layer 1: category picker (bottom-right notification)
    const pickedCategory = await pickFromNotification(
        'Wrapper: choose a category',
        categories.map(cat => ({ label: cat }))
    );
    if (!pickedCategory) { return; }

    const catName = pickedCategory;
    const entries = categoryMap[catName];

    // Flatten { label: value } pairs from the entry array
    const items: Array<{ label: string; detail: string }> = [];
    for (const entry of entries) {
        for (const [label, value] of Object.entries(entry)) {
            items.push({ label, detail: value });
        }
    }
    if (items.length === 0) { return; }

    // Layer 2: action picker (bottom-right notification)
    const pickedItem = await pickFromNotification(
        `Wrapper: ${catName}`,
        items
    );
    if (!pickedItem) { return; }

    // Dispatch
    if (catName === 'Command') {
        const entry = items.find(item => item.label === pickedItem);
        if (entry) {
            await runCommand(context, entry.label, entry.detail, useWslLabels);
        }
    } else {
        // Everything that is not "Command" is treated as content/prompt
        const entry = items.find(item => item.label === pickedItem);
        if (entry) {
            await sendToTerminal(context, entry.detail);
        }
    }
}

// --- Terminal helpers ---------------------------------------------------------

function createTerminal(label: string, useWsl: boolean): vscode.Terminal {
    const isWindows = os.platform() === 'win32';

    if (isWindows && useWsl) {
        return vscode.window.createTerminal({
            name: `Wrapper [${label}]`,
            shellPath: 'wsl.exe',
            shellArgs: ['-d', 'Ubuntu'],
        });
    }

    return vscode.window.createTerminal({ name: `Wrapper [${label}]` });
}

/**
 * Execute a shell command in a dedicated terminal.  The new terminal becomes
 * the shared target so subsequent Content sends land in the same session.
 */
async function runCommand(
    context: vscode.ExtensionContext,
    label: string,
    command: string,
    useWslLabels: string[]
) {
    const useWsl = useWslLabels.includes(label);
    sharedTerminal = createTerminal(label, useWsl);
    sharedTerminal.show(true /* preserve focus */);
    sharedTerminal.sendText(command);
}

/**
 * Send a prompt/text to the shared terminal (passes it directly as stdin to
 * whatever interactive process - e.g. Claude or Coder - is running there).
 * Falls back to the VS Code active terminal if no shared terminal exists yet.
 */
async function sendToTerminal(
    context: vscode.ExtensionContext,
    prompt: string
) {
    let target = sharedTerminal ?? vscode.window.activeTerminal;

    if (!target) {
        const choice = await vscode.window.showWarningMessage(
            'Wrapper: no active terminal found. Start a Command first, or open a terminal.',
            'Open Terminal'
        );
        if (choice === 'Open Terminal') {
            sharedTerminal = createTerminal('Wrapper', false);
            sharedTerminal.show(true);
            target = sharedTerminal;
        } else {
            return;
        }
    }

    // Make the target terminal active, then send the text as a raw terminal
    // sequence.  sendText() wraps input in bracketed-paste markers
    // (\x1b[200~...\x1b[201~) which causes interactive CLIs like Claude and
    // Coder to display "[Paste #1: N chars]" instead of the actual text.
    // sendSequence sends raw bytes to the active terminal with no wrapping, so
    // the program sees the characters as if the user typed them.
    target.show(true);
    await vscode.commands.executeCommand(
        'workbench.action.terminal.sendSequence',
        { text: prompt }
    );
}

