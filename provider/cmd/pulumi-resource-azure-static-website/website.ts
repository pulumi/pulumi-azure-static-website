// Copyright 2016-2022, Pulumi Corporation.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as pulumi from "@pulumi/pulumi";
import * as auth from "@pulumi/azure-native/authorization";
import * as resources from "@pulumi/azure-native/resources";
import * as storage from "@pulumi/azure-native/storage";
import * as cdn from "@pulumi/azure-native/cdn";
import * as network from "@pulumi/azure-native/network";
import * as mime from "mime";
import * as glob from "glob";

import { CdnManagementClient } from "@azure/arm-cdn";
import { DefaultAzureCredential } from "@azure/identity";

import { local } from "@pulumi/command";

export interface WebsiteArgs {
    sitePath: string;
    indexDoc?: string;
    errorDoc?: string;
    cdn?: boolean | WebsiteCDNConfig;
    domain?: WebsiteDomainConfig;
    storage?: WebsiteStorageConfig;
}

export interface WebsiteStorageConfig {
    customDomain?: string;
    enableHttpsTrafficOnly?: boolean;
}

export interface WebsiteCDNConfig {
    isCompressionEnabled?: boolean;
    contentTypesToCompress?: string[];
}

export interface WebsiteDomainConfig {
    name: string;
    subdomain: string;
    resourceGroupName?: string;
}

export class Website extends pulumi.ComponentResource {
    public readonly originURL: pulumi.Output<string>
    public readonly originHostname: pulumi.Output<string>
    public readonly cdnURL?: pulumi.Output<string>;
    public readonly cdnHostname?: pulumi.Output<string>;
    public readonly domainURL?: pulumi.Output<string>;
    public readonly resourceGroupName: pulumi.Output<string>;

    constructor(name: string, args: WebsiteArgs, opts?: pulumi.ComponentResourceOptions) {
        super("azure-static-website:index:Website", name, args, opts);

        args.indexDoc = args.indexDoc || "index.html";
        args.errorDoc = args.errorDoc || "error.html";
        
        if (typeof args.cdn !== "undefined" && typeof args.cdn !== "boolean") {
            args.cdn.isCompressionEnabled = !!args.cdn.isCompressionEnabled;
            args.cdn.contentTypesToCompress = args.cdn.contentTypesToCompress || [
                "text/html",
                "text/css",
                "application/javascript",
                "application/json",
                "image/svg+xml",
                "font/woff",
                "font/woff2"
            ];
        } else {
            args.cdn = !!args.cdn;
        }

        // Create an Azure resource group to manage the website's resources.
        const resourceGroup = new resources.ResourceGroup("resource-group", {}, { parent: this });
        const storageAccountName = pulumi.interpolate`account$`

        // Create a storage account for the website.
        const storageAccount = new storage.StorageAccount("storage", {
            resourceGroupName: resourceGroup.name,
            kind: storage.Kind.StorageV2,
            sku: {
                name: storage.SkuName.Standard_LRS,
            },
            
            // This attempts to set a CNAME for the storage account, which is required for
            // externally managed DNS records (e.g., CNAMEs) that point directly to the
            // storage endpoint, but it probably can't actually work like this, because
            // Azure fails if the CNAME doesn't exist (e.g., at the third-party provider
            // -- it checks), but of course, the CNAME itself can't be defined until the
            // storage bucket account is created (and assigned a dynamic name). So will
            // probably need to revisit, likely with the Command Provider -- or
            // alternatively, as with S3, support an explicit storage-account name, or one
            // named internally here in an idempotent way. In fact (thinking aloud in
            // comments), one of the latter options would probably do it.
            // accountName: args.storage && args.storage.customDomain ? args.storage.customDomain : undefined,
            customDomain: args.storage && args.storage.customDomain ? {
                name: args.storage.customDomain,
                useSubDomainName: false,
            } : undefined, 
            enableHttpsTrafficOnly: args.storage?.enableHttpsTrafficOnly,
        }, { parent: this });

        // Configure the storage account as a website.
        const website = new storage.StorageAccountStaticWebsite("website", {
            resourceGroupName: resourceGroup.name,
            accountName: storageAccount.name,
            indexDocument: args.indexDoc,
            error404Document: args.errorDoc,
        }, { parent: this });

        // Upload the files of the website as managed Pulumi resources.
        const sitePath = args.sitePath;
        const files = glob.sync(`${sitePath}/**/*`, { nodir: true });
        files.map(file => {
            const relativePath = file.replace(`${sitePath}/`, "");
            new storage.Blob(relativePath, {
                accountName: storageAccount.name,
                resourceGroupName: resourceGroup.name,
                containerName: website.containerName,
                source: new pulumi.asset.FileAsset(file),
                contentType: mime.getType(relativePath) || "text/plain",
            }, { parent: this });
        });

        this.originURL = storageAccount.primaryEndpoints.web;
        this.originHostname = storageAccount.primaryEndpoints.apply(endpoints => new URL(endpoints.web)).hostname;

        // Create a profile for the CDN.
        if (args.cdn || (args.domain?.name && args.domain?.subdomain)) {

            const profile = new cdn.Profile("cdn-profile", {
                resourceGroupName: resourceGroup.name,
                sku: {
                    name: cdn.SkuName.Standard_Microsoft,
                },
            }, { parent: this });

            // Create an endpoint for the CDN that points to the website as its sole origin.
            const endpoint = new cdn.Endpoint("cdn-endpoint", {
                resourceGroupName: resourceGroup.name,
                profileName: profile.name,
                isHttpAllowed: false,
                isHttpsAllowed: true,
                isCompressionEnabled: typeof args.cdn !== "boolean" && args.cdn?.isCompressionEnabled,
                contentTypesToCompress: typeof args.cdn !== "boolean" && args.cdn?.contentTypesToCompress || [],
                originHostHeader: this.originHostname,
                origins: [
                    { 
                        name: storageAccount.name,
                        hostName: this.originHostname,
                    }
                ],
            }, { parent: this });

            this.cdnURL = pulumi.interpolate`https://${endpoint.hostName}`;
            this.cdnHostname = endpoint.hostName;

            if (args.domain?.name && args.domain?.subdomain && args.domain?.resourceGroupName) {
                
                // Create a CNAME for the CDN endpoint. Note that since we create a resource group for this site but not a DNS zone, the DNS zone by definition lives in another resource group, so we require it as a config item with custom domains.
                // Also note that this may need to be removed manually in the portal or CLI before a `pulumi destroy` will work. (Because of Azure restrictions , depending on your settings.)
                // az feature register --namespace Microsoft.Network --name BypassCnameCheckForCustomDomainDeletion
                // az feature list -o table --query "[?contains(name, 'Microsoft.Network/BypassCnameCheckForCustomDomainDeletion')].{Name:name,State:properties.state}"
                // az provider register -n Microsoft.Network
                // Also, is it possible to query for all groups and then find the group that contains the specified zone, so it doesn't have to be provided?
                const dnsResourceGroup = resources.getResourceGroupOutput({ resourceGroupName: args.domain.resourceGroupName });

                const cnameRecord = new network.RecordSet("dns-record", {
                    resourceGroupName: dnsResourceGroup.name,
                    relativeRecordSetName: args.domain.subdomain,
                    zoneName: args.domain.name,
                    recordType: "CNAME",
                    targetResource: {
                        id: endpoint.id,
                    },
                }, { parent: this });

                const cnameHostname = cnameRecord.fqdn.apply(s => s.split(".").filter(s => s !== "").join("."));

                // Create a custom domain.
                const domain = new cdn.CustomDomain("custom-domain", {
                    resourceGroupName: resourceGroup.name,
                    profileName: profile.name,
                    endpointName: endpoint.name,
                    hostName: cnameHostname,
                }, { parent: this });

                // Provision a managed SSL/TLS certificate for the custom domain. This
                // isn't supported as a resource unfortunately, so until it is, we use the
                // Command provider (and the Azure CLI) ore the Azure Node.js SDK for it.
                // https://github.com/pulumi/pulumi-azure-native/issues/1443
                // https://github.com/azure/azure-rest-api-specs/issues/17498
                // https://github.com/azure/azure-sdk-for-js
                // const cert = new local.Command("enable-https", {
                //     create: pulumi.interpolate`az cdn custom-domain enable-https --resource-group ${resourceGroup.name} --profile-name ${profile.name} --endpoint-name ${endpoint.name} --name ${domain.name}`,
                // }, { parent: this });

                this.enableCustomHTTPS(resourceGroup.name, profile.name, endpoint.name, domain.name);           

                this.domainURL = pulumi.interpolate`https://${cnameHostname}`;
            }
        }

        // Also export the website's resource group name as a convenience for filtering in the Azure portal.
        this.resourceGroupName = resourceGroup.name;

        this.registerOutputs({
            originURL: this.originURL,
            originHostname: this.originHostname,
            cdnURL: this.cdnURL,
            cdnHostname: this.cdnHostname,
            domainURL: this.domainURL,
            resourceGroupName: this.resourceGroupName,
        });
    }

    enableCustomHTTPS(resourceGroupName: pulumi.Output<string>, profileName: pulumi.Output<string>, endpointName: pulumi.Output<string>, domainName: pulumi.Output<string>) {
        const clientConfig = pulumi.output(auth.getClientConfig());
        const subscriptionID = clientConfig.subscriptionId;

        pulumi.all([ resourceGroupName, profileName, endpointName, domainName, subscriptionID ])
            .apply(async ([ resourceGroupName, profileName, endpointName, domainName, subscriptionID ]) => {
                const client = new CdnManagementClient(new DefaultAzureCredential(), subscriptionID);
                
                try {
                    const result = await client.customDomains.enableCustomHttps(resourceGroupName, profileName, endpointName, domainName);
                    console.log({ result });
                } catch (err) {
                    console.error({ err });
                }
            }
        );
    }
}
