# HomeKeeper · Friction log

First-hand notes from deploying HomeKeeper on **AWS Lightsail** (18 to 19 October 2026, us-east-1). HomeKeeper is an Alexa+ Simulate agent with MCP tools, a household memory server and a photos-to-3D service, so the live demo runs as three containers in one Lightsail container service (`medium`: 1 vCPU, 2 GB, $40 a month) behind the public HTTPS endpoint. Every entry below happened while building it, with the exact message where there was one, and each fact was re-checked against the AWS CLI on 19 October. Each entry follows the hackathon format: task, steps, expected vs actual, severity, workaround, suggestion.

| # | Friction | Severity |
| --- | --- | --- |
| 1 | A failed deployment says only "Took too long" | High |
| 2 | Environment secrets come back in plain text, in every kept deployment version | High |
| 3 | Container services have no persistent storage | High |
| 4 | `medium` means different sizes and prices for instances and container services | Medium |
| 5 | Only one deployment at a time, and no way to cancel it | Medium |
| 6 | `get-container-log` returns nothing, silently, outside its default window | Medium |
| 7 | Resource names clash across resource types | Low |
| 8 | Image references use one counter across all labels | Low |

## 1. A failed deployment says only "Took too long" (High)

- **Task:** deploy the three containers behind the public endpoint, with a health check on `/health`.
- **Steps:** `create-container-service` (medium, scale 1); `push-container-image` for the app and 3D images; `create-container-service-deployment` with the three containers and a public endpoint health check on `/health`; waited.
- **Expected:** if the health check fails, the deployment log says why, such as the HTTP status the check received.
- **Actual:** the deployment ended `FAILED` and the public URL returned 503. The only lines in the container log were `[deployment:1] Creating your deployment`, `[deployment:1] Started 1 new node`, the app's own `HomeKeeper local host ready on port 8789.`, and `[deployment:1] Took too long`. Nothing said the health check was getting a 403: the app rejects unknown `Host` headers, and the health check arrives with the container's own address as the host.
- **Workaround:** reasoned from the app's own logs, answered `/health` before the host allow-list, and redeployed. The next deployment went `ACTIVE`.
- **Suggestion:** record the last health check result (HTTP status and a short response snippet) in the deployment log and console. Also document that health checks send the container's address as the `Host` header.

## 2. Environment secrets come back in plain text, in every kept deployment version (High)

- **Task:** give the containers a model API key and a narrowly scoped AWS key.
- **Steps:** set both as environment variables in the deployment JSON; made six deployments while fixing configuration; then called `get-container-service-deployments` and compared the returned values with the originals.
- **Expected:** a reference to a secret store (Secrets Manager or SSM Parameter Store), or at least masked values in API responses.
- **Actual:** the API returns every environment value in plain text. Lightsail keeps every deployment version: all six were still listed, and the oldest carried the same model key as the newest. Rotating a key therefore leaves old copies readable by anyone allowed to call `GetContainerServiceDeployments`. Among the 14 container service operations in the SDK, none deletes a deployment version (only images and the whole service can be deleted).
- **Workaround:** limited the AWS key to read and write one S3 object, capped the number of model calls inside the app, and plan to revoke the keys at the provider after the event.
- **Suggestion:** let container environment variables reference Secrets Manager or SSM Parameter Store, mask values in API responses, and add a way to delete old deployment versions.

## 3. Container services have no persistent storage (High)

- **Task:** run an app that keeps household records in SQLite, plus a counter that must survive restarts.
- **Steps:** read the container service documentation and the create-service options before deploying.
- **Expected:** an option to attach a small persistent volume, as instances have.
- **Actual:** a container service has no disk that outlives a container, so anything written at runtime is lost on every restart or redeploy. I found this by reading before deploying, not by losing data, but it decides what you can host.
- **Workaround:** baked the demo records into the image, and stored the one value that must survive restarts, a lifetime AI-call counter, as a small object in a private S3 bucket with conditional writes.
- **Suggestion:** offer small persistent volumes (or an EFS mount) for container services, and state the limitation on the create-service page, not only in the docs.

## 4. `medium` means different sizes and prices for instances and container services (Medium)

- **Task:** pick a container service size to match the 4 GB, 2 vCPU instance I had planned.
- **Steps:** priced the instance bundle `medium_3_0`, then created a container service with power `medium`.
- **Expected:** `medium` is the same size and price in both products.
- **Actual:** the instance `medium_3_0` is 2 vCPU, 4 GB for $24 a month. The container service `medium` is 1 vCPU, 2 GB for $40 a month, and the 2 vCPU, 4 GB container size is `large` at $80 a month (`get-container-service-powers`, `get-bundles`). I assumed the names matched, quoted the wrong specs and found out only afterwards. The same 2 vCPU, 4 GB costs $80 as a container service against $24 as an instance.
- **Workaround:** measured real use (`get-container-service-metric-data`: peak memory about 11% of the 2 GB) and kept the size.
- **Suggestion:** print vCPU, RAM and monthly price when a service is created, avoid reusing size names for different specs, and show the instance versus container price for the same specs in the console.

## 5. Only one deployment at a time, and no way to cancel it (Medium)

- **Task:** change one setting while an earlier deployment was still activating.
- **Steps:** `create-container-service-deployment` while deployment 3 was still `ACTIVATING`.
- **Expected:** the new deployment replaces or queues behind the old one, or I can cancel the old one.
- **Actual:** `Sorry, deployment 3 is in progress for service "homekeeper-app". Please wait for it to complete before trying again.` Activation takes several minutes because each deployment pulls the large 3D image again, so every configuration mistake costs one full cycle.
- **Workaround:** waited for deployment 3 to finish, then deployed the corrected configuration.
- **Suggestion:** let a new deployment supersede one that is still activating, or add a cancel command. Showing image pull progress in the console would also help.

## 6. `get-container-log` returns nothing, silently, outside its default window (Medium)

- **Task:** see why the first deployment failed.
- **Steps:** `get-container-log --service-name homekeeper-app --container-name local-host` with no time arguments.
- **Expected:** the most recent log lines, or a message saying the window held nothing.
- **Actual:** exit code 0 and zero events. The same call with `--start-time` set to the day before returned the six lines, including `Took too long` (checked again on 19 October: 0 events by default, 6 with an explicit start time). Nothing said the default window had excluded them, so I first took the logs to be empty.
- **Workaround:** always pass `--start-time`.
- **Suggestion:** return the latest lines regardless of age, or add a hint when the default window excludes older events, and document the default window.

## 7. Resource names clash across resource types (Low)

- **Task:** create a container service named `homekeeper`.
- **Steps:** `create-container-service --service-name homekeeper` while an instance named `homekeeper` existed in the same account and region.
- **Expected:** a container service and an instance are different resources, so the same name is fine.
- **Actual:** `Resource with name "homekeeper" already exists.` The message does not say what type of resource holds the name.
- **Workaround:** used the name `homekeeper-app`.
- **Suggestion:** name the conflicting resource type in the error, or allow the same name across types.

## 8. Image references use one counter across all labels (Low)

- **Task:** reference two pushed images, labelled `app` and `roomtrace`, in one deployment.
- **Steps:** `push-container-image --label app`, then `--label roomtrace`, then `--label app` again after a code change.
- **Expected:** a version per label, or a stable tag such as `:latest`.
- **Actual:** one counter is shared across labels, so the references were `:homekeeper-app.app.16`, `:homekeeper-app.roomtrace.17`, `:homekeeper-app.app.18`. The number says nothing about which image changed, and each reference has to be copied from that push's output into the deployment file.
- **Workaround:** read each push result and edited the image names in the deployment file by hand.
- **Suggestion:** support stable tags per label, or version each label separately, and let the push command print the reference in a machine-readable form.
