'use strict';
import { Position } from 'vscode-languageserver-types/lib/main';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as commands from './commands';
import * as file from './helpers/filehandler';
import * as fs from 'fs';
import * as log from './helpers/logging';
import * as defprov from './language/ui5/Ui5DefinitionProviders';
// import * as mcp from './language/ui5/ManifestCompletionItemProvider';
import { LanguageClient, LanguageClientOptions, SettingMonitor, ServerOptions, TransportKind } from 'vscode-languageclient';
import * as path from 'path';
import { ManifestDiagnostics } from './language/ui5/Ui5ManifestDiagnostics'
import { Ui5i18nCompletionItemProvider } from './language/ui5/Ui5CompletionProviders'
import { ManifestCompletionItemProvider } from './language/ui5/Ui5ManifestCompletionProviders'
import { XmlDiagnostics } from './language/xml/XmlDiagnostics'
import { closeEmptyTag } from './language/xml/xmlCodeProviders'

export const name = "ui5-ts";
export class Ui5Extension {
    namespacemappings?: { [id: string]: string; };
    manifest?: Manifest;
    extensionPath?: string;
    schemaStoragePath?: string;
}

const ui5_jsonviews: vscode.DocumentFilter = { language: 'json', scheme: 'file', pattern: "*.view.json" };
const ui5_xmlviews: vscode.DocumentFilter = { language: 'xml', scheme: "file", pattern: "*.view.xml" };
const langxml = { language: 'xml', scheme: "file", pattern: "*.xml" };
const ui5_tscontrollers: vscode.DocumentFilter = { language: 'typescript', scheme: 'file', pattern: "*.controller.ts" };
const ui5_jscontrollers: vscode.DocumentFilter = { language: 'javascript', scheme: 'file', pattern: "*.controller.js" };
const ui5_jsonfragments: vscode.DocumentFilter = { language: 'json', scheme: 'file', pattern: "*.fragment.json" };
const ui5_xmlfragments: vscode.DocumentFilter = { language: "xml", scheme: 'file', pattern: "*.fragment.xml" };
const ui5_manifest: vscode.DocumentFilter = { language: "json", scheme: 'file', pattern: "**/manifest.json" };

export var core: Ui5Extension = new Ui5Extension();
export var channel = vscode.window.createOutputChannel("UI5 TS Extension");
var context: vscode.ExtensionContext;

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(c: vscode.ExtensionContext) {
    context = c;
    core.extensionPath = c.extensionPath;
    core.schemaStoragePath = c.asAbsolutePath("schemastore");
    // Use the console to output diagnostic information (console.log) and errors (console.error)
    // This line of code will only be executed once when your extension is activated
    console.log('Activating UI5 extension.');

    startXmlViewLanguageServer(context);
    // startManifestLanguageServer();

    getAllNamespaceMappings();

    // Hook the commands
    // context.subscriptions.push(vscode.commands.registerCommand('ui5ts.SetupUi5', commands.SetupUi5));
    c.subscriptions.push(vscode.commands.registerTextEditorCommand('ui5ts.SwitchToView', commands.SwitchToView.bind(context)));
    c.subscriptions.push(vscode.commands.registerTextEditorCommand('ui5ts.SwitchToController', commands.SwitchToController.bind(context)));
    c.subscriptions.push(vscode.commands.registerCommand('ui5ts.AddSchemaToStorage', commands.AddSchemaToStore.bind(context)));
    vscode.window.onDidChangeTextEditorSelection(closeEmptyTag);

    // Setup Language Providers
    // c.subscriptions.push(vscode.languages.registerDefinitionProvider(ui5_xmlviews, new defprov.Ui5ViewDefinitionProvider));
    // c.subscriptions.push(vscode.languages.registerDefinitionProvider(ui5_jsonviews, new defprov.Ui5ViewDefinitionProvider));
    // c.subscriptions.push(vscode.languages.registerDefinitionProvider(ui5_tscontrollers, new defprov.Ui5ControllerDefinitionProvider));
    // c.subscriptions.push(vscode.languages.registerDefinitionProvider(ui5_jscontrollers, new defprov.Ui5ControllerDefinitionProvider));
    // c.subscriptions.push(vscode.languages.registerDefinitionProvider(ui5_xmlfragments, new defprov.Ui5FragmentDefinitionProvider))
    // c.subscriptions.push(vscode.languages.registerDefinitionProvider(ui5_jsonfragments, new defprov.Ui5FragmentDefinitionProvider));

    channel.appendLine("Starting Ui5i18nCompletionItemProvider");
    // c.subscriptions.push(vscode.languages.registerCompletionItemProvider([ui5_xmlviews, ui5_xmlfragments], new Ui5i18nCompletionItemProvider));

    let md = new ManifestDiagnostics(vscode.languages.createDiagnosticCollection('json'));
    let xmld = new XmlDiagnostics(vscode.languages.createDiagnosticCollection('xml'), c);

    c.subscriptions.push(md.diagnosticCollection);
    c.subscriptions.push(xmld.diagnosticCollection);

    vscode.workspace.onDidChangeTextDocument(md.diagnoseManifest.bind(md));
    vscode.workspace.onDidChangeTextDocument(xmld.diagnose.bind(xmld));

    c.subscriptions.push(vscode.languages.registerCompletionItemProvider(ui5_manifest, new ManifestCompletionItemProvider));
}

async function getAllNamespaceMappings() {
    core.namespacemappings = {};
    // search all html files
    let docs = await file.File.find(".*\\.(html|htm)$");
    for (let doc of docs) {
        try {
            let text = (await vscode.workspace.openTextDocument(vscode.Uri.parse("file:///" + doc))).getText();
            // get script html tag with data-sap-ui-resourceroots
            let scripttag = text.match(/<\s*script[\s\S]*sap-ui-core[\s\S]*data-sap-ui-resourceroots[\s\S]*?>/m)[0];
            if (!scripttag)
                continue;
            let resourceroots = scripttag.match(/data-sap-ui-resourceroots.*?['"][\s\S]*?{([\s\S]*)}[\s\S]*['"]/m)[1];
            if (!resourceroots)
                continue;
            for (let rr of resourceroots.split(",")) {
                let entry = rr.split(":");
                let key = entry[0].trim();
                let val = entry[1].trim();
                log.printInfo("Found " + key + " to replace with " + val);
                core.namespacemappings[key.substr(1, key.length - 2)] = val.substr(1, val.length - 2);
            }
        }
        catch (error) {

        }
    }
    console.info(core.namespacemappings);
}

// this method is called when your extension is deactivated
export function deactivate() {

}

function startXmlViewLanguageServer(context: vscode.ExtensionContext): void {
    // The server is implemented in node
    log.printInfo("Staring XML View language server");
    let serverModule = (context.asAbsolutePath(path.join('server', 'server.js')));
    // The debug options for the server
    let debugOptions = { execArgv: ["--nolazy", "--debug=6009"] };

    // If the extension is launched in debug mode then the debug server options are used
    // Otherwise the run options are used
    let serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions }
    }

    // Options to control the language client
    let clientOptions: LanguageClientOptions = {
        // Register the server for xml decuments documents
        documentSelector: ['xml', 'xsd'],
        synchronize: {
            // Synchronize the setting section 'languageServerExample' to the server
            configurationSection: 'ui5ts',
            // Notify the server about file changes to '.clientrc files contain in the workspace
            fileEvents: vscode.workspace.createFileSystemWatcher('**/.clientrc')
        },
        initializationOptions: { schemastore: context.asAbsolutePath("schemastore") }
    }

    // Create the language client and start the client.
    let disposable = new LanguageClient('UI5 XML Language Client', serverOptions, clientOptions).start();
    // Push the disposable to the context's subscriptions so that the 
    // client can be deactivated on extension deactivation
    context.subscriptions.push(disposable);
}

