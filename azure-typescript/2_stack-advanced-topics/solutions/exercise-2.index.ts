import * as insights from "@pulumi/azure-native/insights";
import * as resource from "@pulumi/azure-native/resources";
import * as sql from "@pulumi/azure-native/sql";
import * as storage from "@pulumi/azure-native/storage";
import * as web from "@pulumi/azure-native/web";
import * as pulumi from "@pulumi/pulumi";


// Get the password to use for SQL from config.
const config = new pulumi.Config();
const baseName = config.get("baseName") || pulumi.getStack();
const username = config.get("sqlUsername") || "pulumi";
// Exercise 1 //
const pwd = config.requireSecret("sqlPassword");
export const dbPassword = pwd;
// Exercise 1 //

const resourceGroup = new resource.ResourceGroup(`${baseName}-rg`);

// Storage Account name must be lowercase and cannot have any dash characters
const storageAccount = new storage.StorageAccount(`${baseName.toLowerCase()}sa`, {
    resourceGroupName: resourceGroup.name,
    kind: storage.Kind.StorageV2,
    sku: {
        name: storage.SkuName.Standard_LRS,
    },
});

const storageAccountKeys = pulumi.all([resourceGroup.name, storageAccount.name]).apply(([resourceGroupName, accountName]) =>
    storage.listStorageAccountKeys({ resourceGroupName, accountName }));

// Exercise 2/2a //
const primaryStorageKey = pulumi.secret(storageAccountKeys.keys[0].value);
// Exercise 2/2a //

const appServicePlan = new web.AppServicePlan(`${baseName}-asp`, {
    resourceGroupName: resourceGroup.name,
    kind: "App",
    sku: {
        name: "B1",
        tier: "Basic",
    },
});

const storageContainer = new storage.BlobContainer(`${baseName}-container`, {
    resourceGroupName: resourceGroup.name,
    accountName: storageAccount.name,
    publicAccess: storage.PublicAccess.None,
});

const blob = new storage.Blob(`${baseName}-blob`, {
    resourceGroupName: resourceGroup.name,
    accountName: storageAccount.name,
    containerName: storageContainer.name,
    source: new pulumi.asset.FileArchive("wwwroot"),
});

const codeBlobUrl = getSASToken(storageAccount.name, storageContainer.name, blob.name, resourceGroup.name);

const appInsights = new insights.Component(`${baseName}-ai`, {
    resourceGroupName: resourceGroup.name,
    kind: "web",
    applicationType: insights.ApplicationType.Web,
});

const sqlServer = new sql.Server(`${baseName}-sql`, {
    resourceGroupName: resourceGroup.name,
    administratorLogin: username,
    administratorLoginPassword: pwd,
    version: "12.0",
});

const database = new sql.Database(`${baseName}-db`, {
    resourceGroupName: resourceGroup.name,
    serverName: sqlServer.name,
    sku: {
        name: "S0",
    },
});

const app = new web.WebApp(`${baseName}-webapp`, {
    resourceGroupName: resourceGroup.name,
    serverFarmId: appServicePlan.id,
    siteConfig: {
        appSettings: [
            {
                name: "APPINSIGHTS_INSTRUMENTATIONKEY",
                value: appInsights.instrumentationKey,
            },
            {
                name: "APPLICATIONINSIGHTS_CONNECTION_STRING",
                value: pulumi.interpolate`InstrumentationKey=${appInsights.instrumentationKey}`,
            },
            {
                name: "ApplicationInsightsAgent_EXTENSION_VERSION",
                value: "~2",
            },
            {
                name: "WEBSITE_RUN_FROM_PACKAGE",
                value: codeBlobUrl,
            },
        ],
        connectionStrings: [{
            name: "db",
            connectionString:
                pulumi.all([sqlServer.name, database.name]).apply(([server, db]) =>
                    `Server=tcp:${server}.database.windows.net;initial catalog=${db};user ID=${username};password=${pwd};Min Pool Size=0;Max Pool Size=30;Persist Security Info=true;`),
            type: web.ConnectionStringType.SQLAzure,
        }],
    },
});

export const dbUserName = username;
export const storageAccountKey = primaryStorageKey;
export const appHostName = app.defaultHostName;


/////// Helper Function ///////
function getSASToken(storageAccountName: pulumi.Input<string>,
    storageContainerName: pulumi.Input<string>,
    blobName: pulumi.Input<string>,
    resourceGroupName: pulumi.Input<string>): pulumi.Output<string> {
const blobSAS = storage.listStorageAccountServiceSASOutput({
accountName: storageAccountName,
protocols: storage.HttpProtocol.Https,
sharedAccessStartTime: "2021-01-01",
sharedAccessExpiryTime: "2030-01-01",
resource: storage.SignedResource.C,
resourceGroupName: resourceGroupName,
permissions: storage.Permissions.R,
canonicalizedResource: pulumi.interpolate `/blob/${storageAccountName}/${storageContainerName}`,
contentType: "application/json",
cacheControl: "max-age=5",
contentDisposition: "inline",
contentEncoding: "deflate",
});
const token = blobSAS.apply(x => x.serviceSasToken);
return pulumi.interpolate `https://${storageAccountName}.blob.core.windows.net/${storageContainerName}/${blobName}?${token}`;
}