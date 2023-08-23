# CovReport

A GitHub action that comments the test coverage report on the pull request.

## Usage

To use this action, add the following to your workflow:

uses: itsparser/covreport@v1


You can also pass the following optional inputs to the action:

* `path`: The path to the coverage report file.
* `title`: The title of the comment.
* `threshold`: The minimum coverage percentage.

## Example

The following is an example of a workflow that uses the `CovReport` action:

```
name: Test Coverage

on:
  pull_request:
  types: [opened, reopened, synchronize, edited]

jobs:
  test:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v2
      - name: Install dependencies
        run: yarn install
      - name: Run tests
        run: yarn test
      - name: Comment test coverage
        uses: itsparser/covreport@v1
        env:
          path: coverage/lcov.info
          title: "Test Coverage"
          threshold: 80

```
This workflow will run the tests, generate a coverage report, and comment the information on the pull request. The comment will include the overall coverage percentage and the coverage percentage for each file.

Contributing
Contributions are welcome! Please open an issue or a pull request if you have any improvement ideas.

License
This project is licensed under the MIT License.

I hope this helps!
