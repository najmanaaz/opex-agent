import * as path from "node:path";
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps, Tags } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";
import type { OpexConfig } from "./config";

export interface WebStackProps extends StackProps {
  readonly config: OpexConfig;
  readonly certificate: acm.ICertificate;
  readonly apiUrl: string;
  readonly userPoolClientId: string;
}

// The app at opex.t4tangerine.com: one static page (web/) on a private S3
// bucket behind CloudFront, plus /app-config.json with the API and sign-in
// settings written at deploy time.
export class WebStack extends Stack {
  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);
    const { config } = props;
    Tags.of(this).add("app", config.appName);

    const bucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, "SecurityHeaders", {
      securityHeadersBehavior: {
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
        contentSecurityPolicy: {
          override: true,
          contentSecurityPolicy: [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src https://fonts.gstatic.com",
            "img-src 'self' data:",
            `connect-src 'self' https://*.execute-api.${this.region}.amazonaws.com https://*.auth.${this.region}.amazoncognito.com https://cdn.jsdelivr.net`,
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "form-action 'self'",
          ].join("; "),
        },
      },
    });

    const distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: `${config.appName} app (${config.appDomain})`,
      domainNames: [config.appDomain],
      certificate: props.certificate,
      defaultRootObject: "index.html",
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: securityHeaders,
      },
    });

    new s3deploy.BucketDeployment(this, "DeploySite", {
      destinationBucket: bucket,
      sources: [
        s3deploy.Source.asset(path.join(__dirname, "..", "web")),
        s3deploy.Source.jsonData("app-config.json", {
          apiUrl: props.apiUrl,
          loginUrl: config.auth.loginUrl,
          clientId: props.userPoolClientId,
          publicSiteUrl: config.publicSiteUrl,
        }),
      ],
      cacheControl: [s3deploy.CacheControl.fromString("no-cache")],
      distribution,
      distributionPaths: ["/*"],
    });

    new CfnOutput(this, "CloudFrontDomain", { value: distribution.distributionDomainName });
    new CfnOutput(this, "AppUrl", { value: config.appUrl });
  }
}
