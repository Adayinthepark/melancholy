"use client";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "./ui/accordion";
import { BookOpen, ExternalLink } from "lucide-react";
const githubGuide =
  "https://github.com/adayinthepark/melancholy/blob/main/docs/credentials.md#github";
const cloudflareGuide =
  "https://github.com/adayinthepark/melancholy/blob/main/docs/credentials.md#cloudflare";
export function CredentialGuide({
  provider,
  compact = false,
}: {
  provider: "github" | "cloudflare";
  compact?: boolean;
}) {
  const github = provider === "github";
  const guide = github ? githubGuide : cloudflareGuide;
  const create = github
    ? "https://github.com/settings/personal-access-tokens/new"
    : "https://dash.cloudflare.com/profile/api-tokens";
  if (compact)
    return (
      <p className="credential-guide-short">
        {github
          ? "Use a fine-grained personal access token for the repositories you need."
          : "Use a user API token from My Profile. Account-owned tokens are not supported yet."}{" "}
        <a href={guide} target="_blank" rel="noopener noreferrer">
          Setup guide <ExternalLink size={12} />
        </a>
      </p>
    );
  return (
    <Accordion type="single" collapsible className="credential-guide">
      <AccordionItem value="setup">
        <AccordionTrigger>
          <BookOpen size={16} />
          <span>How to configure {github ? "GitHub" : "Cloudflare"}</span>
        </AccordionTrigger>
        <AccordionContent>
          {github ? (
            <>
              <ol>
                <li>
                  <a href={create} target="_blank" rel="noopener noreferrer">
                    Create a fine-grained personal access token
                  </a>
                  . Choose your organization as the resource owner and select
                  only the repositories you need.
                </li>
                <li>
                  For issue management, allow{" "}
                  <strong>Issues: Read and write</strong>. Metadata read access
                  is included. For coding, also allow{" "}
                  <strong>Contents: Read and write</strong> and{" "}
                  <strong>Pull requests: Read and write</strong>.
                </li>
                <li>
                  If your organization requires approval, wait until the token
                  is approved. Copy it into <strong>Add credential</strong>.
                </li>
              </ol>
            </>
          ) : (
            <>
              <ol>
                <li>
                  Open{" "}
                  <a href={create} target="_blank" rel="noopener noreferrer">
                    My Profile → API Tokens
                  </a>{" "}
                  and create a user API token. Start with{" "}
                  <strong>Edit Cloudflare Workers</strong>, then review the
                  permissions below.
                </li>
                <li>
                  Limit account resources to your deployment account and zone
                  resources to the domain you deploy to. Add{" "}
                  <strong>D1: Edit</strong> for this project’s database.
                </li>
                <li>
                  Copy the token into <strong>Add credential</strong>. Find the{" "}
                  <strong>Account ID</strong> in your account’s dashboard and
                  save it too.
                </li>
              </ol>
              <div className="credential-guide-table">
                <table>
                  <thead>
                    <tr>
                      <th>Resource</th>
                      <th>Access for melancholy</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Account</td>
                      <td>
                        Workers Scripts: Edit; Workers R2 Storage: Edit; D1:
                        Edit; Account Settings: Read
                      </td>
                    </tr>
                    <tr>
                      <td>Zone</td>
                      <td>
                        Zone: Read; Workers Routes: Edit for the deployment
                        domain
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p>
                Add DNS: Edit only if the agent needs to change DNS records. Use
                a user API token; account-owned tokens and the Global API Key
                are not supported by this form.
              </p>
            </>
          )}
          <p>
            <strong>After saving:</strong> open <strong>Channel access</strong>{" "}
            and enable only the conversations whose agents may use this
            credential. For GitHub, link repositories from the channel’s{" "}
            <strong>Repositories and issues</strong> button.
          </p>
          <p>
            Saving checks the token’s validity. Repository and deployment
            permissions are checked when you use them.
          </p>
          <a href={guide} target="_blank" rel="noopener noreferrer">
            Full setup and troubleshooting guide <ExternalLink size={13} />
          </a>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
