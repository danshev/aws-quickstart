import * as codecommit from "aws-cdk-lib/aws-codecommit";
import type { Construct } from "constructs";

export interface SourceRepositoryProps {
  readonly repositoryName: string;
}

export function createSourceRepository(
  scope: Construct,
  id: string,
  props: SourceRepositoryProps,
): codecommit.IRepository {
  return new codecommit.Repository(scope, id, {
    repositoryName: props.repositoryName,
  });
}
