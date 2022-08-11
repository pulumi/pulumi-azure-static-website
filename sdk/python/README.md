# pulumi-azure-static-website

Still very much 🚧 👷.

## Usage

```typescript
import * as pulumi from "@pulumi/pulumi";
import * as website from "@pulumi/azure-static-website";

const site = new website.Website("site", {
    sitePath: "./site",
});

export const { originURL } = site;
```

```yaml
name: my-website
runtime: yaml
description: A static website build with pulumi-azure-static-website.

resources:
  site:
    type: azure-static-website:index:Website
    properties:
      sitePath: ./site

outputs:
  originURL: ${site.originURL}
```
