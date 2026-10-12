/** Public authored data allowlist for the Vera Solaro native workspace. */
import { getBuilderReleaseTargets } from "../../../builder/registry.ts";
export const authoredSettingKeys = ["site", "vera_payment_pricing"];
export const nativeBaseSeedDataTables = ["options", "ap_vera_services", "ap_vera_calendly_mappings"];
export const nativeDynamicCollections: Record<string, { fields: { slug: string; type: string; required?: boolean }[] }> = {
  "posts": {
    "fields": [
      {
        "slug": "title",
        "type": "string",
        "required": true
      },
      {
        "slug": "featured_image",
        "type": "image"
      },
      {
        "slug": "content",
        "type": "portableText"
      },
      {
        "slug": "excerpt",
        "type": "text"
      },
      {
        "slug": "category",
        "type": "string"
      }
    ]
  }
};
export const nativeSeedAssetAliases = [];
export const nativePrivateEmailSampleKeys = ["email", "message", "phone", "resetUrl", "confirmationUrl", "unsubscribeUrl", "giftCode"];
export const nativeEmailMappings = [
  [
    "accountUrl",
    "event_payload",
    "accountUrl"
  ],
  [
    "balanceAmount",
    "event_payload",
    "balanceAmount"
  ],
  [
    "bookingNumber",
    "event_payload",
    "bookingNumber"
  ],
  [
    "campaignBody",
    "event_payload",
    "campaignBody"
  ],
  [
    "campaignSubject",
    "event_payload",
    "campaignSubject"
  ],
  [
    "confirmationUrl",
    "event_payload",
    "confirmationUrl"
  ],
  [
    "customerName",
    "event_payload",
    "customerName"
  ],
  [
    "giftAmount",
    "event_payload",
    "giftAmount"
  ],
  [
    "giftCode",
    "event_payload",
    "giftCode"
  ],
  [
    "meetingDetails",
    "event_payload",
    "meetingDetails"
  ],
  [
    "paidAmount",
    "event_payload",
    "paidAmount"
  ],
  [
    "priceAmount",
    "event_payload",
    "priceAmount"
  ],
  [
    "reportTitle",
    "event_payload",
    "reportTitle"
  ],
  [
    "resetUrl",
    "event_payload",
    "resetUrl"
  ],
  [
    "scheduledDateTime",
    "event_payload",
    "scheduledDateTime"
  ],
  [
    "selectedSlot",
    "event_payload",
    "selectedSlot"
  ],
  [
    "serviceName",
    "event_payload",
    "serviceName"
  ],
  [
    "siteUrl",
    "generated_url",
    "urls.site"
  ],
  [
    "supportFooter",
    "business_setting",
    "notificationSettings.supportFooter"
  ],
  [
    "unsubscribeUrl",
    "generated_url",
    "urls.unsubscribe"
  ],
  [
    "verificationUrl",
    "event_payload",
    "verificationUrl"
  ]
];
export const nativeEmailDisplayVariables: string[] = [];
export const nativeEmailDisplayMappings: string[] = [];
export const nativeGeneratedUrlMappings = ["site", "unsubscribe"];
export const nativeBaseSettingKeys = ["payment_preference", "site", "vera_payment_pricing"];
export const nativeEmailSampleValueTypes: Record<string,string> = {
  "accountUrl": "string",
  "balanceAmount": "string",
  "bookingNumber": "string",
  "campaignBody": "string",
  "campaignSubject": "string",
  "confirmationUrl": "string",
  "customerName": "string",
  "giftAmount": "string",
  "giftCode": "string",
  "meetingDetails": "string",
  "paidAmount": "string",
  "priceAmount": "string",
  "reportTitle": "string",
  "resetUrl": "string",
  "scheduledDateTime": "string",
  "selectedSlot": "string",
  "serviceName": "string",
  "siteUrl": "string",
  "supportFooter": "string",
  "unsubscribeUrl": "string",
  "verificationUrl": "string",
  "email": "string",
  "phone": "string",
  "message": "string"
};
export const nativeStaticAssets: { path: string; digest: string }[] = [];
export const nativeStaticAssetPaths = nativeStaticAssets.map((asset) => asset.path);
const baseColumns = ["id", "slug", "status", "primary_byline_id", "created_at", "updated_at", "published_at", "scheduled_at", "deleted_at", "version", "live_revision_id", "draft_revision_id", "locale", "translation_group", "title"];
export const nativeCollectionColumns: Record<string,string[]> = {};
for (const target of getBuilderReleaseTargets()) {
  nativeCollectionColumns[target.collection] = [...new Set([...(nativeCollectionColumns[target.collection] ?? baseColumns), ...target.fields])];
}
nativeCollectionColumns.posts = [...new Set([...baseColumns, ...nativeDynamicCollections.posts.fields.map((field) => field.slug)])];
