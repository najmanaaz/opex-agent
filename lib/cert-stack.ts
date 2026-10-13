import { CfnOutput, Stack, StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import { Construct } from "constructs";
import type { OpexConfig } from "./config";

export interface CertStackProps extends StackProps {
  readonly config: OpexConfig;
}

// HTTPS certificate for the app's domain. CloudFront only accepts certificates
// from us-east-1, so this is the one stack outside the main region; it holds no
// data. DNS is managed outside AWS, so validation is manual: while this stack
// deploys, add the CNAME record ACM shows for the domain.
export class CertStack extends Stack {
  readonly certificate: acm.Certificate;

  constructor(scope: Construct, id: string, props: CertStackProps) {
    super(scope, id, props);
    this.certificate = new acm.Certificate(this, "AppCertificate", {
      domainName: props.config.appDomain,
      validation: acm.CertificateValidation.fromDns(),
    });
    new CfnOutput(this, "CertificateArn", { value: this.certificate.certificateArn });
  }
}
