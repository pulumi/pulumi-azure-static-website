// Copyright 2016-2021, Pulumi Corporation.
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
import * as resources from "@pulumi/azure-native/resources";
import * as storage from "@pulumi/azure-native/storage";
import * as cdn from "@pulumi/azure-native/cdn";
import * as network from "@pulumi/azure-native/network";
import * as mime from "mime";
import * as glob from "glob";

import { local } from "@pulumi/command";

export interface WebsiteArgs {
    /**
     * The .
     */
    sitePath: string;
    
    /**
     * The .
     */
    indexDocument: string;

    /**
     * The .
     */
    errorDocument: string;

    /**
     * The .
     */
    withCDN: boolean;
}

export class Website extends pulumi.ComponentResource {
    public readonly resourceGroupName: pulumi.Output<string>;
    public readonly originURL: pulumi.Output<string>
    public readonly cdnURL?: pulumi.Output<string>;
    public readonly customDomainURL?: pulumi.Output<string>;

    private sitePath: string;
    private indexDocument?: string;
    private errorDocument?: string;
    private withCDN: boolean;

    constructor(name: string, args: WebsiteArgs, opts?: pulumi.ComponentResourceOptions) {
        super("azure-static-website:index:Website", name, args, opts);

        this.sitePath = args.sitePath;
        this.indexDocument = args.indexDocument || "index.html";
        this.errorDocument = args.errorDocument || "error.html";
        this.withCDN = args.withCDN;

        // Create a resource group to contain the website's resources.
        const resourceGroup = new resources.ResourceGroup("resource-group");

        // Create a storage account for the website.
        const account = new storage.StorageAccount("account", {
            resourceGroupName: resourceGroup.name,
            kind: storage.Kind.StorageV2,
            sku: {
                name: storage.SkuName.Standard_LRS,
            },
        });

        // Configure the storage account as a website.
        const website = new storage.StorageAccountStaticWebsite("website", {
            resourceGroupName: resourceGroup.name,
            accountName: account.name,
            indexDocument: this.indexDocument,
            error404Document: this.errorDocument,
        });

        // Upload the files of the website as managed Pulumi resources.
        const sitePath = this.sitePath;
        const files = glob.sync(`${sitePath}/**/*`, { nodir: true });
        files.map(file => {
            const relativePath = file.replace(`${sitePath}/`, "");
            new storage.Blob(relativePath, {
                accountName: account.name,
                resourceGroupName: resourceGroup.name,
                containerName: website.containerName,
                source: new pulumi.asset.FileAsset(file),
                contentType: mime.getType(relativePath) || "text/plain",
            });
        });

        // Create a profile for the CDN.
        if (this.withCDN) {
            const profile = new cdn.Profile("profile", {
                resourceGroupName: resourceGroup.name,
                sku: {
                    name: cdn.SkuName.Standard_Microsoft,
                },
            });

            // Create an endpoint for the CDN that points to the website as its sole origin.
            const origin = account.primaryEndpoints.apply(endpoints => new URL(endpoints.web));
            const endpoint = new cdn.Endpoint("endpoint", {
                resourceGroupName: resourceGroup.name,
                profileName: profile.name,
                isHttpAllowed: false,
                isHttpsAllowed: true,
                isCompressionEnabled: true,
                contentTypesToCompress: [
                    "text/html",
                    "text/css",
                    "application/javascript",
                    "application/json",
                    "image/svg+xml",
                    "font/woff",
                    "font/woff2",
                ],
                originHostHeader: origin.hostname,
                origins: [
                    { 
                        name: account.name,
                        hostName: origin.hostname,
                    }
                ],
            });

            this.cdnURL = pulumi.interpolate`https://${endpoint.hostName}`;

            if (false) {
                // Create a CNAME for the CDN endpoint. Note that since we create a resource group for this site but not a DNS zone, the DNS zone by definition lives in another resource group, so we require it as a config item with custom domains.
                // Also note that this may need to be removed manually in the portal or CLI before a `pulumi destroy` will work. (Because of Azure restrictions.)
                const dnsResourceGroup = resources.getResourceGroupOutput({ resourceGroupName: "pulumi-dev-shared" });
                const cname = new network.RecordSet("cname", {
                    resourceGroupName: dnsResourceGroup.name,
                    relativeRecordSetName: "my-site",
                    zoneName: "pulumi-dev.net",
                    recordType: "CNAME",
                    targetResource: {
                        id: endpoint.id,
                    },
                });

                // Create a custom domain.
                const domain = new cdn.CustomDomain("domain", {
                    resourceGroupName: resourceGroup.name,
                    profileName: profile.name,
                    endpointName: endpoint.name,
                    hostName: cname.fqdn.apply(s => s.split(".").filter(s => s !== "").join(".")), // Swap out the trailing dot.
                }, { dependsOn: cname }); // Remove this if it doesn't make a difference.

                // Provision a managed SSL/TLS certificate for the custom domain. This isn't supported as a resource unfortunately, so until it is, we use the Command provider (and the Azure CLI) to create it. 
                // https://github.com/pulumi/pulumi-azure-native/issues/1443
                // https://github.com/Azure/azure-rest-api-specs/issues/17498
                const cert = new local.Command("enable-https", {
                    create: pulumi.interpolate`az cdn custom-domain enable-https --resource-group ${resourceGroup.name} --profile-name ${profile.name} --endpoint-name ${endpoint.name} --name ${domain.name}`,
                });

                this.customDomainURL = cname.fqdn.apply(fqdn => `https://${fqdn.split(".").filter(s => s !== "").join(".")}`);
            }
        }

        // Export our URLs.
        this.originURL = account.primaryEndpoints.web;
        
        // Also export the website's resource group name as a convenience for filtering in the Azure portal.
        this.resourceGroupName = resourceGroup.name;

        this.registerOutputs({
            originURL: this.originURL,
            cdnURL: this.cdnURL,
            customDomainURL: this.customDomainURL,
            resourceGroupName: this.resourceGroupName,
        });
    }
}
