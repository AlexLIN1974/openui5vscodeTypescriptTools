'use strict';
import { I18nDiagnosticProvider } from './language/xml/XmlDiagnostics';
import {
    I18nDfinitionProvider,
    Ui5ViewDefinitionProvider,
    ViewControllerDefinitionProvider,
    ViewFragmentDefinitionProvider
} from './language/ui5/Ui5DefinitionProviders';
import { AddI18nLabel, AddSchemaToStore, ResetI18nStorage, SwitchToController, SwitchToView } from './commands';
import {
    commands,
    DiagnosticCollection,
    DocumentFilter,
    ExtensionContext,
    languages,
    TextDocument,
    TextDocumentChangeEvent,
    Uri,
    window,
    workspace
} from 'vscode';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as file from './helpers/filehandler';
import * as fs from 'fs';
import * as log from './helpers/logging';
import * as defprov from './language/ui5/Ui5DefinitionProviders';
// import * as mcp from './language/ui5/ManifestCompletionItemProvider';
import { LanguageClient, LanguageClientOptions, SettingMonitor, ServerOptions, TransportKind } from 'vscode-languageclient';
import * as path from 'path';
import { ManifestDiagnostics } from './language/ui5/Ui5ManifestDiagnostics'
import { I18NCompletionItemProvider } from './language/ui5/Ui5CompletionProviders'
import { ManifestCompletionItemProvider } from './language/ui5/Ui5ManifestCompletionProviders'
import { I18nCodeActionprovider } from './language/xml/XmlActionProviders'

export interface IDiagnose {
    diagnose(document: TextDocument)
    diagnosticCollection: DiagnosticCollection
}

export class Ui5Extension {
    namespacemappings?: { [id: string]: string; };
    manifest?: Manifest;
    extensionPath?: string;
    schemaStoragePath?: string;
    relativemainfestlocation: string;
    absolutemanifestlocation: string

    /**
     * Creates a relative workspace path to manifest.json file from the namespace
     * 
     * @param {string} path 
     * @returns {string} 
     * 
     * @memberOf Ui5Extension
     */
    CreateRelativePath(namespace: string): string {
        for (let map in this.namespacemappings) {
            if (namespace.startsWith(map)) {
                let relpath = path.normalize(path.join(ui5tsglobal.core.relativemainfestlocation, namespace.replace(map, this.namespacemappings[map]).replace(/\./g, "/").replace(/\/\/+/g, "/")));
                if (relpath.startsWith("/") || relpath.startsWith("\\"))
                    return relpath.substring(1).replace(/\\/g, "/");
                else
                    return relpath.replace(/\\/g, "/");
            }
        }
    }

    GetFullNameByFile(file: string): string {
        let m = path.dirname(ui5tsglobal.core.absolutemanifestlocation);
        let fn = path.dirname(file);
        let rel = "./" + path.relative(m, fn).replace("\\", "/") + "/" + path.basename(window.activeTextEditor.document.fileName);
        // rel = rel.replace(/\.controller\.(ts|fs)$/, "").replace(/[\/\\]/g, ".");
        let sources: {k: string, v: string}[] = [];
        for(let ns in ui5tsglobal.core.namespacemappings) {
            let relsource = ui5tsglobal.core.namespacemappings[ns];
            if(rel.startsWith(relsource))
                sources.push( {k: relsource, v: ns } );
        }
        let bestmatch;
        if(sources.length>1) {
            bestmatch = sources.sort((a, b) => a.k.length-b.k.length).pop();
        } else 
            bestmatch = sources[0];
        return bestmatch.v + "." + rel.substring(2).replace(/\.controller\.(ts|fs)$/, "").replace(/[\/\\]/g, ".");
    }
}

export namespace ui5tsglobal {
    export const name = "ui5-ts";
    export const core: Ui5Extension = new Ui5Extension();

}

const ui5_jsonviews: DocumentFilter = { language: 'json', scheme: 'file', pattern: "*.view.json" };

const ui5_tscontrollers: DocumentFilter = { language: 'typescript', scheme: 'file', pattern: "**/*.controller.ts" };
const ui5_jscontrollers: DocumentFilter = { language: 'javascript', scheme: 'file', pattern: "**/*.controller.js" };
const ui5_jsonfragments: DocumentFilter = { language: 'json', scheme: 'file', pattern: "**/*.{fragment,view}.json" };

const ui5_xml: DocumentFilter = { language: "xml", scheme: 'file', pattern: "**/*.{fragment,view}.xml" };
const ui5_view: DocumentFilter = { language: "xml", scheme: "file", pattern: "**/*.view.xml" };
const ui5_fragment: DocumentFilter = { language: "xml", scheme: "file", pattern: "**/*.fragment.xml" };

const ui5_manifest: DocumentFilter = { language: "json", scheme: 'file', pattern: "**/manifest.json" };

export var channel = window.createOutputChannel("UI5 TS Extension");
var context: ExtensionContext;

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(c: ExtensionContext) {
    context = c;
    ui5tsglobal.core.extensionPath = c.extensionPath;
    ui5tsglobal.core.schemaStoragePath = c.asAbsolutePath("schemastore");
    // Use the console to output diagnostic information (console.log) and errors (console.error)
    // This line of code will only be executed once when your extension is activated
    console.log('Activating UI5 extension.');

    getManifestLocation();

    startXmlViewLanguageServer(context);
    // startManifestLanguageServer();

    getAllNamespaceMappings();

    // Hook the commands
    // context.subscriptions.push(commands.registerCommand('ui5ts.SetupUi5', commands.SetupUi5));
    c.subscriptions.push(commands.registerTextEditorCommand('ui5ts.SwitchToView', SwitchToView.bind(context)));
    c.subscriptions.push(commands.registerTextEditorCommand('ui5ts.SwitchToController', SwitchToController.bind(context)));
    c.subscriptions.push(commands.registerCommand('ui5ts.AddSchemaToStorage', AddSchemaToStore.bind(context)));
    c.subscriptions.push(commands.registerCommand('ui5ts.CreateNewI18nLabel', AddI18nLabel.bind(context)));
    c.subscriptions.push(commands.registerCommand('ui5ts.ResetI18NStorage', ResetI18nStorage.bind(context)));

    // Setup Language Providers
    console.log("Creating I18N Provider!");
    c.subscriptions.push(languages.registerCodeActionsProvider(ui5_xml, new I18nCodeActionprovider));

    // c.subscriptions.push(languages.registerCompletionItemProvider([ui5_xmlviews, ui5_xmlfragments], new Ui5i18nCompletionItemProvider));

    let diags: IDiagnose[] = [new ManifestDiagnostics(languages.createDiagnosticCollection('json')), new I18nDiagnosticProvider(languages.createDiagnosticCollection('i18n'))];

    createDiagnosticSubscriptions(c, diags);

    workspace.onDidSaveTextDocument((doc) => {
        if (!doc.fileName.endsWith(".properties"))
            return;

        ResetI18nStorage();
        for (let otd of workspace.textDocuments)
            for (let diag of diags)
                diag.diagnose(otd);
    });

    // Completionitemproviders
    c.subscriptions.push(languages.registerCompletionItemProvider(ui5_manifest, new ManifestCompletionItemProvider));
    c.subscriptions.push(languages.registerCompletionItemProvider(ui5_xml, new I18NCompletionItemProvider));

    // Definitionproviders
    c.subscriptions.push(languages.registerDefinitionProvider(ui5_view, new ViewFragmentDefinitionProvider));
    c.subscriptions.push(languages.registerDefinitionProvider(ui5_view, new ViewControllerDefinitionProvider));
    c.subscriptions.push(languages.registerDefinitionProvider(ui5_xml, new I18nDfinitionProvider));
    c.subscriptions.push(languages.registerDefinitionProvider(ui5_xml, new Ui5ViewDefinitionProvider))
}

function createDiagnosticSubscriptions(c: ExtensionContext, diags: IDiagnose[]) {
    for (let diag of diags) {
        c.subscriptions.push(diag.diagnosticCollection);
        workspace.onDidChangeTextDocument((changes: TextDocumentChangeEvent) => {
            diag.diagnose(changes.document);
        });
        workspace.onDidOpenTextDocument(diag.diagnose.bind(diag));
    }
    for (let otd of workspace.textDocuments)
        for (let diag of diags)
            diag.diagnose(otd);
}

function getManifestLocation() {
    try {
        var workspaceroot = workspace.rootPath
        let manifest = workspace.findFiles("manifest.json", '').then((value) => {
            let val = value;
            ui5tsglobal.core.absolutemanifestlocation = val[0].fsPath;
            ui5tsglobal.core.relativemainfestlocation = path.relative(workspaceroot, val[0].fsPath).replace("manifest.json", "");
        });

    } catch (error) {

    }
}

async function getAllNamespaceMappings() {
    ui5tsglobal.core.namespacemappings = {};
    // search all html files
    let docs = await file.File.find(".*\\.(html|htm)$");
    for (let doc of docs) {
        try {
            let text = (await workspace.openTextDocument(Uri.parse("file:///" + doc))).getText();
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
                ui5tsglobal.core.namespacemappings[key.substr(1, key.length - 2)] = val.substr(1, val.length - 2);
            }
        }
        catch (error) {

        }
    }
    console.info(ui5tsglobal.core.namespacemappings);
}

// this method is called when your extension is deactivated
export function deactivate() {

}

function startXmlViewLanguageServer(context: ExtensionContext): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        // The server is implemented in node
        log.printInfo("Staring XML View language server");
        let serverModule = context.asAbsolutePath(path.join('server', 'server.js'));
        // The debug options for the server
        let debugOptions = { storagepath: context.asAbsolutePath("schemastore"), execArgv: ["--nolazy", "--debug=6009"] };

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
            diagnosticCollectionName: "xmlDiagnostics",
            synchronize: {
                // Synchronize the setting section 'languageServerExample' to the server
                configurationSection: 'ui5ts',
                // Notify the server about file changes to '.clientrc files contain in the workspace
                fileEvents: workspace.createFileSystemWatcher("**/*.{xml,xsd}", false, false, false)
            },
            initializationOptions: { storagepath: context.asAbsolutePath("schemastore") } as XmlInitOptions
        }

        // Create the language client and start the client.
        let disposable = new LanguageClient('XmlLangServer', serverOptions, clientOptions);
        // Push the disposable to the context's subscriptions so that the 
        // client can be deactivated on extension deactivation
        context.subscriptions.push(disposable.start());
    })

}

/**
 * Initialization options for the xml language server
 * 
 * @interface XmlInitOptions
 */
interface XmlInitOptions {
    /**
     * asolute path to the folder of the xsd files
     * 
     * @type {string}
     * @memberOf XmlInitOptions
     */
    storagepath: string;
}